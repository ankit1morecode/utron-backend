// gemini.js — ULTRON AIR's language / reasoning service.
//
// Talks to the Gemini REST `generateContent` endpoint directly (no SDK, no new
// npm dependencies). Three public surfaces:
//   askGemini()           conversational reply, per-user session memory
//   generateStructured()  JSON-out call used by the orchestrator (intent, plan)
//   translateText()       one-shot translation, never touches a chat session
//
// Everything funnels through one callGemini() that owns the timeout, the
// bounded retry and the error formatting, so a flaky upstream can never hang a
// request forever and the orchestrator can always tell *which* service died.

// gemini-2.0-flash was RETIRED by Google and 404s. The 404 body named
// gemini-3.6-flash as the replacement; verified with a real call on 2026-09-13.
// The deployed server overrides this with GEMINI_MODEL, so the outage was
// invisible there — but a fresh checkout would have inherited a dead default,
// which is how the two Sarvam deprecations also stayed hidden for so long.
const DEFAULT_MODEL = 'gemini-3.6-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 3; // 1 initial try + 2 retries
const RETRY_BASE_DELAY_MS = 400; // exponential: 400ms, 800ms (+ jitter)
// 429 is deliberately ABSENT. Google's free tier limit is per-DAY
// (GenerateRequestsPerDayPerProjectPerModel-FreeTier, 20 requests), so
// retrying the same model half a second later cannot help — it just burns
// three requests instead of one. A 429 falls through to the next model in
// the chain instead, which has its own separate quota bucket.
const RETRY_STATUSES = new Set([408, 500, 502, 503, 504]);
const ERROR_BODY_MAX = 400; // truncate upstream bodies inside error messages

// Session cap. 20 *turns* = 40 messages (a user message + a model message per
// turn). In-process only: fine for a demo / single node. Swap for a shared
// store if this is ever horizontally scaled.
const MAX_SESSION_TURNS = 20;
const MAX_SESSION_MESSAGES = MAX_SESSION_TURNS * 2;

// The persona. This is spoken aloud through earbuds, so the constraints here
// are as much about *audio* as about tone — and the honesty rules exist because
// this product makes safety claims it must never fake.
export const SYSTEM_INSTRUCTION = [
  'You are ULTRON, an AI assistant that lives inside a pair of smart earbuds.',
  '',
  'LANGUAGE',
  "- Reply in the user's own language. If they speak Hindi or Hinglish, reply in natural",
  '  conversational Hindi/Hinglish (Roman script is fine if they used Roman script).',
  '  If they speak English, reply in English. Match regional Indian languages the same way.',
  '- Never announce which language you are using. Just use it.',
  '',
  'SPEECH FORMAT — your reply is converted to speech and played in the ear.',
  '- Keep it short: one or two sentences. Long answers are painful to listen to.',
  '- No markdown, no asterisks, no headings, no bullet lists, no emoji, no code blocks.',
  '- Write numbers, times, units and symbols the way a person says them:',
  '  "twenty five percent", "seven thirty PM", "two hundred rupees" — not "25%", "7:30pm", "Rs.200".',
  '- No URLs or file paths unless the user explicitly asked for one.',
  '- If the answer is genuinely long, give the one-line version and offer to continue.',
  '',
  'HONESTY ABOUT DEVICE ACTIONS — hard rule, never break it.',
  '- You do NOT control the phone or the earbuds. The phone performs actions and reports back.',
  '- Never say an action is done. Do not say "call placed", "volume increased", "noise cancellation is on",',
  '  "music is playing" or "message sent". Acknowledge only what is ABOUT to happen:',
  '  "Calling Mom now", "Turning noise cancellation on", "Sure, playing that".',
  '- If you are unsure whether something happened, say you are not sure. Never guess a success.',
  '- Never claim to sense the real world. You cannot hear horns, sirens, traffic or alarms,',
  '  and you cannot see. Environmental hazard detection is not a capability you have.',
  '- Never invent contacts, notifications, battery levels, song names, locations or message contents.',
  '  If you were not given the information, say you do not have it.',
  '',
  'WHEN YOU CANNOT DO SOMETHING',
  '- Say so plainly in one short sentence, then offer the closest thing you can actually do.',
  '- Do not apologise repeatedly and do not explain your internal architecture.',
  '',
  'SAFETY',
  '- If the user sounds like they are in danger or asks for emergency help, keep the reply extremely',
  '  short, say what you are about to do, and prioritise reaching their emergency contact.',
  '- If the user seems to be driving, be brief and never ask them to look at the screen.',
].join('\n');

// Spoken fallback when Gemini answers with an empty candidate (filtered, empty
// parts array...). Short and honest — it does not pretend anything happened.
const EMPTY_REPLY_FALLBACK = 'Sorry, mujhe uska jawab nahi mila. Ek baar phir bolo?';

/** userId -> array of Gemini `contents` entries ({ role, parts: [{ text }] }). */
const sessions = new Map();

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

// Env is read lazily, never at module load: dotenv may not have run yet
// depending on import order, and tests may set keys after import.
function apiKey() {
  const key = process.env.GEMINI_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

function modelName() {
  const m = process.env.GEMINI_MODEL;
  return m && m.trim() ? m.trim() : DEFAULT_MODEL;
}

function timeoutMs() {
  const raw = Number(process.env.GEMINI_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export function isGeminiConfigured() {
  return apiKey() !== null;
}


/* ------------------------------------------------------------------ *
 * Credential health
 *
 * `isGeminiConfigured()` answers "is a key present", which is NOT the same as
 * "does the key work". /health reported this service as up while every call
 * came back 401, which is precisely the kind of claim this product is not
 * supposed to make.
 *
 * So we remember what the upstream last told us. A 401/403 is a verdict on the
 * credential itself, not a transient fault, and it is sticky until a call
 * succeeds. Nothing here costs an extra request: it only records outcomes of
 * calls that were happening anyway.
 * ------------------------------------------------------------------ */

let credentialRejected = false;
let lastRejectionDetail = null;

/** Called on every upstream response so /health can stop guessing. */
function recordOutcome(status) {
  if (status === 401 || status === 403) {
    credentialRejected = true;
    lastRejectionDetail =
      'Google rejected the API key (HTTP ' + status + '). Check GEMINI_API_KEY in server/.env.';
    return;
  }
  if (status >= 200 && status < 300) {
    credentialRejected = false;
    lastRejectionDetail = null;
  }
}

/** True only when a key is present AND has not been rejected by the upstream. */
export function isGeminiUsable() {
  return isGeminiConfigured() && !credentialRejected;
}

/** Why it is unusable, or null. Safe to show: contains no key material. */
export function geminiCredentialError() {
  if (!isGeminiConfigured()) return 'GEMINI_API_KEY is not set in server/.env.';
  return lastRejectionDetail;
}

function requireKey(where) {
  if (!isGeminiConfigured()) {
    throw new Error(
      `Gemini unavailable: GEMINI_API_KEY is not set on the server (needed by ${where}). ` +
        'Add GEMINI_API_KEY to server/.env — see .env.example.',
    );
  }
}

/* ------------------------------------------------------------------ */
/* low-level transport                                                 */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function truncate(text, max = ERROR_BODY_MAX) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/** Error carrying the upstream HTTP status so callers can branch on it. */
class GeminiError extends Error {
  constructor(message, { status = null, retryable = false, body = '' } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.service = 'gemini';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

/**
 * One request to generateContent. Owns timeout + retry + error shaping.
 *
 * @param {object} payload full request body (contents, systemInstruction, generationConfig)
 * @param {object} [options] { label } — label names the caller in error messages
 * @returns {Promise<object>} parsed Gemini response JSON
 */
/**
 * Tokens the model spends REASONING before it emits a visible word.
 *
 * Gemini 3.x thinks before answering, and those thoughts are charged against
 * `maxOutputTokens` — so a budget sized for the answer alone buys almost no
 * answer at all. Measured on gemini-3.6-flash on 2026-09-14:
 *
 *   cap  thoughts  visible  finishReason   text
 *   220     208        8    MAX_TOKENS     "The capital of France is Paris. I"
 *   220     210        6    MAX_TOKENS     "Sunlight scatters off the"
 *   600     212        7    STOP           "The capital of France is Paris."
 *   600     413       32    STOP           (complete)
 *
 * Every spoken reply the app has ever produced was being cut off mid-sentence
 * at the old 220 cap, and nothing reported it: the response was non-empty, so
 * it looked like a valid answer.
 *
 * `thinkingConfig: { thinkingBudget: 0 }` is NOT a way out — this model rejects
 * it with HTTP 400. Headroom is the only lever.
 *
 * 640 covers the worst observed spend (559) with margin. It is a ceiling, not a
 * spend: `usageMetadata` above shows thinking stopping well short of it, and
 * unused budget costs nothing.
 */
const THINKING_HEADROOM_TOKENS = 640;

/**
 * Add thinking headroom so `maxOutputTokens` means what callers assume: the
 * length of the ANSWER, not the answer plus the model's private reasoning.
 *
 * Done here rather than at each call site so a new call site cannot forget it
 * and quietly ship truncated replies — which is exactly how this went unnoticed.
 */
function withThinkingHeadroom(payload) {
  const config = payload && payload.generationConfig;
  if (!config || typeof config.maxOutputTokens !== 'number') return payload;

  return {
    ...payload,
    generationConfig: {
      ...config,
      maxOutputTokens: config.maxOutputTokens + THINKING_HEADROOM_TOKENS,
    },
  };
}

/**
 * Models to try, in order.
 *
 * WHY A CHAIN AND NOT ONE MODEL
 * -----------------------------
 * Google's free tier allows 20 requests per day PER MODEL. Measured, not
 * assumed — the 429 body names the quota:
 *
 *   quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier
 *   value:   20
 *
 * Twenty requests is a few minutes of real use, after which every reply becomes
 * the offline fallback and the app looks broken. But the limit is per model, so
 * a second model is a second allowance. The chain turns "ULTRON stopped
 * working" into "ULTRON got slightly different at some point today".
 *
 * It also covers the other failure this service has already suffered twice: a
 * model being RETIRED (404). gemini-2.0-flash went that way. A chain degrades
 * instead of going dark.
 *
 * The fallbacks are flash-lite variants on purpose: measured at 1.4s against
 * 7-18s for gemini-3.6-flash, and they spend no thinking tokens at all. The
 * fallback is faster than the primary — the cost is answer quality, not speed.
 */
const DEFAULT_FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'];

function modelChain() {
  const raw = process.env.GEMINI_FALLBACK_MODELS;
  const fallbacks =
    raw && raw.trim()
      ? raw.split(',').map((m) => m.trim()).filter(Boolean)
      : DEFAULT_FALLBACK_MODELS;

  const chain = [modelName(), ...fallbacks];
  // Dedupe, preserving order: GEMINI_MODEL may already name a fallback.
  return chain.filter((model, index) => chain.indexOf(model) === index);
}

/**
 * The model that last answered successfully, so /health can report what the
 * app is actually talking to rather than what it was configured to talk to.
 */
let activeModel = null;

export function activeGeminiModel() {
  return activeModel || modelName();
}

/** One model, with its own timeout and bounded retry. */
async function callGeminiOnModel(payload, label, model) {
  const url =
    `${API_BASE}/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(apiKey())}`;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      recordOutcome(response.status);

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new GeminiError(
          `Gemini ${label} failed (HTTP ${response.status}): ${truncate(body)}`,
          {
            status: response.status,
            retryable: RETRY_STATUSES.has(response.status),
            body: truncate(body),
          },
        );
      }

      return await response.json();
    } catch (err) {
      // AbortError is our own timeout; anything that is not a GeminiError and
      // not an abort is a socket/DNS failure. Both are worth one more try.
      const isAbort = err && err.name === 'AbortError';
      const isNetwork = !(err instanceof GeminiError) && !isAbort;

      lastError =
        err instanceof GeminiError
          ? err
          : new GeminiError(
              isAbort
                ? `Gemini ${label} timed out after ${timeoutMs()}ms`
                : `Gemini ${label} network error: ${truncate(err && err.message)}`,
              { retryable: true },
            );

      const retryable = lastError.retryable || isAbort || isNetwork;
      if (!retryable || attempt === MAX_ATTEMPTS) break;

      // Exponential backoff with jitter so parallel callers do not sync up.
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleep(delay + Math.floor(Math.random() * 150));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new GeminiError(`Gemini ${label} failed for an unknown reason`);
}

/**
 * One request to generateContent, walking the model chain.
 *
 * Falls through to the next model on 429 (that model's daily quota is gone) and
 * on 404 (that model has been retired). Every other failure throws immediately:
 * a bad request or a rejected key will fail identically on every model, and
 * marching through the chain would only multiply the latency.
 */
async function callGemini(rawPayload, { label = 'askGemini' } = {}) {
  requireKey(label);

  const payload = withThinkingHeadroom(rawPayload);
  const chain = modelChain();

  let lastError = null;

  for (let index = 0; index < chain.length; index += 1) {
    const model = chain[index];

    try {
      const data = await callGeminiOnModel(payload, label, model);
      if (index > 0) {
        console.warn(
          `[gemini] ${label} fell back to ${model} (${chain[0]} was unavailable). ` +
            'Replies may be shorter or simpler until the primary model recovers.',
        );
      }
      activeModel = model;
      return data;
    } catch (err) {
      lastError = err;
      const status = err instanceof GeminiError ? err.status : null;

      const quotaGone = status === 429;
      const modelGone = status === 404;
      const hasAnother = index < chain.length - 1;

      if ((quotaGone || modelGone) && hasAnother) {
        console.warn(
          `[gemini] ${model} unavailable (HTTP ${status}${
            quotaGone ? ', daily quota exhausted' : ', model retired'
          }). Trying ${chain[index + 1]}.`,
        );
        continue;
      }

      throw err;
    }
  }

  throw lastError || new GeminiError(`Gemini ${label} failed for an unknown reason`);
}

/** Pull the text out of a generateContent response, or explain why there is none. */
function extractText(data) {
  const candidate = data && data.candidates && data.candidates[0];

  // Prompt-level block: there is no candidate at all.
  const blockReason = data && data.promptFeedback && data.promptFeedback.blockReason;
  if (!candidate && blockReason) {
    throw new GeminiError(`Gemini blocked the prompt (${blockReason})`);
  }

  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  const text = parts
    .map((p) => p && p.text)
    .filter(Boolean)
    .join('')
    .trim();

  if (!text && candidate && candidate.finishReason && candidate.finishReason !== 'STOP') {
    throw new GeminiError(`Gemini returned no text (finishReason: ${candidate.finishReason})`);
  }

  /*
   * A truncated answer is not an answer, and this is the check that was
   * missing. The old code only objected when the text was EMPTY, so a reply cut
   * off mid-word — "The capital of France is Paris. I" — sailed through as a
   * success and was spoken to the user as if complete.
   *
   * It is logged rather than thrown: half an answer is still worth more to the
   * user than an error, and the headroom above should make this rare. If it
   * appears in the logs at all, a budget somewhere is too small — that is the
   * signal this line exists to give.
   */
  if (text && candidate && candidate.finishReason === 'MAX_TOKENS') {
    console.warn(
      '[gemini] TRUNCATED: the reply hit maxOutputTokens and was cut off mid-answer. ' +
        `Raise the budget at the call site. Text ended: "...${text.slice(-60)}"`,
    );
  }

  return text;
}

/** Accept either raw Gemini contents or a { role, text } shorthand. */
function normalizeHistory(history = []) {
  if (!Array.isArray(history)) return [];
  return history
    .map((entry) => {
      if (!entry) return null;
      const role = entry.role === 'model' ? 'model' : 'user';
      if (Array.isArray(entry.parts)) return { role, parts: entry.parts };
      if (typeof entry.text === 'string' && entry.text.trim()) {
        return { role, parts: [{ text: entry.text }] };
      }
      return null;
    })
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* askGemini — conversational, session-backed                          */
/* ------------------------------------------------------------------ */

/**
 * Conversational reply with per-user rolling history.
 *
 * @param {string} userId
 * @param {string} message
 * @param {object} [opts]
 * @param {string} [opts.systemInstruction] replace the default persona
 * @param {string} [opts.context] extra grounding appended to the persona
 *   (memories, device state, safety profile)
 * @param {boolean} [opts.persist=true] false = do not write to the session
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.maxOutputTokens=220] earbud replies are short by design
 * @returns {Promise<string>}
 */
export async function askGemini(userId, message, opts = {}) {
  const text = String(message == null ? '' : message).trim();
  if (!text) throw new Error('askGemini: message is empty');

  const key = String(userId == null ? 'anonymous' : userId);
  const history = sessions.get(key) || [];

  const persona = opts.systemInstruction || SYSTEM_INSTRUCTION;
  const systemText = opts.context
    ? `${persona}\n\nCONTEXT YOU MAY USE (do not read it aloud verbatim):\n${opts.context}`
    : persona;

  const contents = [...history, { role: 'user', parts: [{ text }] }];

  const data = await callGemini(
    {
      systemInstruction: { parts: [{ text: systemText }] },
      contents,
      generationConfig: {
        temperature: opts.temperature == null ? 0.7 : opts.temperature,
        maxOutputTokens: opts.maxOutputTokens == null ? 220 : opts.maxOutputTokens,
      },
    },
    { label: 'askGemini' },
  );

  const reply = extractText(data) || EMPTY_REPLY_FALLBACK;

  if (opts.persist !== false) {
    const updated = [...contents, { role: 'model', parts: [{ text: reply }] }].slice(
      -MAX_SESSION_MESSAGES,
    );
    sessions.set(key, updated);
  }

  return reply;
}

/* ------------------------------------------------------------------ *
 * Vision
 * ------------------------------------------------------------------ *
 * Gemini's generateContent is multimodal: an image rides in the same `parts`
 * array as the text, as an `inline_data` blob. That is the whole reason the
 * accessibility vision features need no on-device model and no native code —
 * the camera is already in the app, and this endpoint already exists.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is a round trip to a server. It answers questions about ONE still frame,
 * in about a second, when there is a network. It is emphatically not real-time
 * obstacle detection, and nothing built on it may be described as watching the
 * road or warning the user about anything in motion. That needs a continuous
 * on-device model, which is a different feature with a different risk profile.
 */

/** Max inline image. Gemini's own inline limit is ~20MB of REQUEST, base64 included. */
const VISION_MAX_BASE64_CHARS = 7 * 1024 * 1024;

const VISION_ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

/**
 * Ask a question about one image.
 *
 * @param {string} imageBase64 raw base64, no `data:` prefix
 * @param {string} prompt what to ask about it
 * @param {object} [opts]
 * @param {string} [opts.mimeType='image/jpeg']
 * @param {string} [opts.systemInstruction]
 * @param {number} [opts.maxOutputTokens=260]
 * @returns {Promise<string>}
 */
export async function describeImage(imageBase64, prompt, opts = {}) {
  requireKey('Gemini vision');

  const data = String(imageBase64 == null ? '' : imageBase64).trim();
  if (!data) throw new Error('describeImage: imageBase64 is empty');
  if (data.length > VISION_MAX_BASE64_CHARS) {
    throw new Error(
      `describeImage: image is ${data.length} base64 chars, over the ${VISION_MAX_BASE64_CHARS} limit. ` +
        'Capture at a lower resolution or compress before sending.',
    );
  }

  const mimeType = opts.mimeType || 'image/jpeg';
  if (!VISION_ALLOWED_MIME.has(mimeType)) {
    throw new Error(
      `describeImage: unsupported mimeType "${mimeType}". ` +
        `Supported: ${[...VISION_ALLOWED_MIME].join(', ')}.`,
    );
  }

  const response = await callGemini(
    {
      systemInstruction: {
        parts: [{ text: opts.systemInstruction || SYSTEM_INSTRUCTION }],
      },
      contents: [
        {
          role: 'user',
          // Text first, image second: the instruction frames how the model
          // reads the picture, and the order is what the API documents.
          parts: [
            { text: String(prompt) },
            { inline_data: { mime_type: mimeType, data } },
          ],
        },
      ],
      generationConfig: {
        // Lower than conversation: a description of what is physically in
        // front of a user who may not be able to see it is not the place for
        // invention.
        temperature: 0.2,
        maxOutputTokens: opts.maxOutputTokens == null ? 260 : opts.maxOutputTokens,
      },
    },
    { label: 'describeImage' },
  );

  return extractText(response) || EMPTY_REPLY_FALLBACK;
}

/** Raw session contents for a user (a copy — mutating it does nothing). */
export function getHistory(userId) {
  const key = String(userId == null ? 'anonymous' : userId);
  return (sessions.get(key) || []).map((entry) => ({
    role: entry.role,
    parts: entry.parts.map((p) => ({ ...p })),
  }));
}

/** Forget a user's conversation (used by "start over" and by privacy reset). */
export function resetSession(userId) {
  sessions.delete(String(userId == null ? 'anonymous' : userId));
}

/* ------------------------------------------------------------------ */
/* generateStructured — JSON out                                       */
/* ------------------------------------------------------------------ */

// Gemini's generationConfig.responseSchema is an OpenAPI-3 subset and rejects
// several ordinary JSON-Schema keywords ($schema, additionalProperties, oneOf,
// const, ...) with a 400. Rather than guess, we sanitise what we safely can,
// TRY the request with the schema, and transparently retry without it if the
// API rejects it. Both paths still go through the defensive parser below, so a
// wrong guess about the field shape degrades instead of breaking the route.
const SCHEMA_TYPE_MAP = {
  object: 'OBJECT',
  array: 'ARRAY',
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
};

function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return null;

  const type =
    typeof schema.type === 'string' ? SCHEMA_TYPE_MAP[schema.type.toLowerCase()] : null;
  if (!type) return null; // unions / untyped nodes: not worth risking a 400

  const out = { type };
  if (typeof schema.description === 'string') out.description = schema.description;
  if (Array.isArray(schema.enum) && schema.enum.length) out.enum = schema.enum.map(String);

  if (type === 'OBJECT') {
    const props =
      schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const converted = {};
    for (const [name, child] of Object.entries(props)) {
      const childSchema = toGeminiSchema(child);
      if (childSchema) converted[name] = childSchema;
    }
    if (!Object.keys(converted).length) return null;
    out.properties = converted;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((r) => converted[r])
      : [];
    if (required.length) out.required = required;
  }

  if (type === 'ARRAY') {
    const items = toGeminiSchema(schema.items);
    if (!items) return null;
    out.items = items;
  }

  return out;
}

/** Strip ```json fences and any prose wrapper. */
function stripFences(raw) {
  return String(raw == null ? '' : raw)
    .replace(/^﻿/, '')
    .replace(/```(?:json|JSON)?/g, '')
    .replace(/```/g, '')
    .trim();
}

/**
 * Find the first *balanced* JSON object/array inside a blob of text.
 * Quote- and escape-aware, so braces inside string values do not confuse it.
 */
function extractBalancedJson(text) {
  const closers = { '{': '}', '[': ']' };

  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start];
    const closer = closers[opener];
    if (!closer) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === opener) depth += 1;
      else if (ch === closer) {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Parse model output that is *supposed* to be JSON but might not be. */
function parseJsonLoosely(raw, label) {
  const cleaned = stripFences(raw);

  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through to the balanced scan */
  }

  const candidate = extractBalancedJson(cleaned);
  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Trailing commas are the single most common model JSON defect.
      try {
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        /* fall through to the throw */
      }
    }
  }

  throw new GeminiError(
    `Gemini ${label}: response was not parseable JSON. Received: ${truncate(cleaned, 300)}`,
  );
}

/**
 * Ask Gemini for a JSON object matching `schema`.
 * Used by the orchestrator for intent classification and multi-step planning.
 *
 * @param {object} args
 * @param {string} args.systemInstruction
 * @param {string} args.prompt
 * @param {object} args.schema JSON-schema-ish; also embedded in the prompt
 * @param {Array} [args.history]
 * @returns {Promise<object>}
 * @throws {Error} descriptive error naming Gemini if the call or the parse fails
 */
export async function generateStructured({
  systemInstruction,
  prompt,
  schema,
  history = [],
} = {}) {
  const userPrompt = String(prompt == null ? '' : prompt).trim();
  if (!userPrompt) throw new Error('generateStructured: prompt is empty');

  // The schema goes into the prompt regardless of responseSchema support:
  // restating it measurably improves field fidelity.
  const schemaText = schema ? JSON.stringify(schema, null, 2) : null;
  const jsonRules = [
    'Respond with a single JSON object and NOTHING else.',
    'No markdown, no code fences, no commentary before or after the JSON.',
    schemaText ? `The object must match this schema:\n${schemaText}` : null,
    'If you are unsure of a value use the schema default or an empty value — never omit a required key.',
  ]
    .filter(Boolean)
    .join('\n');

  const systemText = [
    systemInstruction || 'You are a precise JSON-producing planning engine.',
    '',
    jsonRules,
  ].join('\n');

  const contents = [
    ...normalizeHistory(history),
    { role: 'user', parts: [{ text: `${userPrompt}\n\n${jsonRules}` }] },
  ];

  const geminiSchema = toGeminiSchema(schema);

  const buildPayload = (withSchema) => ({
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: {
      temperature: 0.1, // planning wants determinism, not flair
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      ...(withSchema && geminiSchema ? { responseSchema: geminiSchema } : {}),
    },
  });

  let data;
  try {
    data = await callGemini(buildPayload(Boolean(geminiSchema)), {
      label: 'generateStructured',
    });
  } catch (err) {
    // A 400 here is almost always responseSchema being rejected. Retry once
    // with prompt-only schema guidance before giving up on the turn.
    const schemaRejected = geminiSchema && err && err.status === 400;
    if (!schemaRejected) throw err;
    console.warn(
      '[gemini] responseSchema rejected by the API, retrying with prompt-only JSON instructions',
    );
    data = await callGemini(buildPayload(false), { label: 'generateStructured' });
  }

  const text = extractText(data);
  if (!text) throw new GeminiError('Gemini generateStructured returned an empty response');

  return parseJsonLoosely(text, 'generateStructured');
}

/* ------------------------------------------------------------------ */
/* translateText — one shot, session-free                              */
/* ------------------------------------------------------------------ */

/**
 * Translate text. Deliberately stateless: it calls the raw API with NO history
 * so a translation never leaks into (or is polluted by) the user's chat session.
 *
 * @param {string} text
 * @param {string} targetLanguage e.g. 'Hindi', 'hi-IN', 'Tamil'
 * @param {string} [sourceLanguage='auto']
 * @returns {Promise<string>} the translation, and nothing else
 */
export async function translateText(text, targetLanguage, sourceLanguage = 'auto') {
  const input = String(text == null ? '' : text).trim();
  if (!input) throw new Error('translateText: text is empty');
  if (!targetLanguage) throw new Error('translateText: targetLanguage is required');

  const from =
    !sourceLanguage || sourceLanguage === 'auto'
      ? 'Detect the source language automatically.'
      : `The source language is ${sourceLanguage}.`;

  const systemText = [
    'You are a translation engine. You translate text and do nothing else.',
    'Output ONLY the translation.',
    'No preamble, no explanation, no quotation marks around the output,',
    'no transliteration, no romanisation, no notes, no alternatives.',
    'Preserve the original tone, register and punctuation.',
    'Keep proper nouns, brand names and numbers intact.',
    'If the text is already in the target language, return it unchanged.',
  ].join('\n');

  const prompt = `${from}\nTranslate the text below into ${targetLanguage}.\n\nTEXT:\n${input}`;

  const data = await callGemini(
    {
      systemInstruction: { parts: [{ text: systemText }] },
      // Empty history by design — a translation must not join the chat session.
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    },
    { label: 'translateText' },
  );

  const out = extractText(data);
  if (!out) throw new GeminiError('Gemini translateText returned an empty translation');

  // Models occasionally wrap the output in quotes despite the instruction.
  return out.replace(/^["'«»“”]+|["'«»“”]+$/g, '').trim();
}
