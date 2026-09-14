// sarvam.js — ULTRON AIR's speech service (Indian-language TTS + STT).
//
//   textToSpeech()  text  -> base64 audio the phone plays through the earbuds
//   speechToText()  audio -> transcript the orchestrator turns into an intent
//
// Both go through one request helper that owns the timeout, the bounded retry
// and the error text. Every error message says "Sarvam" explicitly so the
// orchestrator can tell a speech failure apart from a language-model failure
// and degrade correctly (text with audio: null, rather than a dead route).

const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech';
const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';
const SARVAM_AUTH_HEADER = 'api-subscription-key';

const DEFAULT_TIMEOUT_MS = 20000;
const STT_TIMEOUT_MS = 45000; // uploading audio is slower than posting text
const MAX_ATTEMPTS = 3; // 1 initial try + 2 retries
const RETRY_BASE_DELAY_MS = 500; // exponential: 500ms, 1000ms (+ jitter)
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const ERROR_BODY_MAX = 400;

/* ---- TTS tuning ---------------------------------------------------- */

// bulbul:v2 was DEPRECATED by Sarvam and now returns
//   "Model 'bulbul:v2' has been deprecated. Please use 'bulbul:v3' instead."
// for every request, so TTS failed 100% of the time regardless of the key.
// Verified against the live API on 2026-09-13.
const TTS_DEFAULT_MODEL = 'bulbul:v3';
// 'meera' belonged to bulbul:v2 and is not a valid v3 speaker. Verified working
// on v3: priya, ritu, neha. The full v3 list is in routes/speech.js.
const TTS_DEFAULT_SPEAKER = 'priya';
// Sarvam caps the length of a single TTS input. Longer text is chunked on
// sentence boundaries rather than hard-sliced mid-word.
const TTS_MAX_CHARS_PER_CHUNK = 1000;
// The API takes an array of inputs and returns an array of audio clips, so a
// few chunks cost one request. We still only *return* the first clip (the
// contract is a single base64 string) — anything beyond that is logged loudly,
// never silently dropped.
const TTS_MAX_INPUTS_PER_REQUEST = 3;

/* ---- STT field names ------------------------------------------------ */
// VERIFY AGAINST CURRENT SARVAM DOCS before shipping. These are the field and
// response names this wrapper believes are correct for the multipart
// speech-to-text endpoint. They are isolated here so a doc change is a
// one-line fix, and speechToText() throws a descriptive error (never returns a
// silently wrong transcript) if the response does not contain a transcript
// under one of the known keys.
const STT_FILE_FIELD = 'file'; // multipart part holding the audio bytes
const STT_LANGUAGE_FIELD = 'language_code'; // e.g. 'hi-IN'
const STT_MODEL_FIELD = 'model';
// saarika:v2 was DEPRECATED by Sarvam and returns, for every request,
//   "Model 'saarika:v2' has been deprecated. Please use 'saaras:v3' instead."
// This is the same failure that killed TTS under bulbul:v2, and it had the same
// symptom: speech-to-text failed 100% of the time with a perfectly valid key,
// so holding the mic button produced nothing and the app blamed the recording.
//
// Verified against the live API on 2026-09-14 by round-tripping our own TTS
// output back through this endpoint. Of the IDs Sarvam currently accepts,
// three transcribe Hindi correctly and in Devanagari (mean latency over two
// clips): saaras:v4 0.77s, saaras:v3 0.84s, saarika:v2.5 1.11s. saarika:v1,
// saarika:v2 and saarika:flash are all deprecated.
//
// saaras:v3 is the default because it is the model Sarvam's own deprecation
// message names, which makes it the ID most likely to keep working. Despite the
// "saaras" family historically meaning speech-to-TRANSLATE, it returns the
// spoken language here rather than English — checked explicitly, because a
// silently translating model would break the Hindi/Hinglish intent matcher
// rather than merely slow it down.
const STT_DEFAULT_MODEL = 'saaras:v3';
const STT_DEFAULT_MIME = 'audio/wav';
const STT_DEFAULT_FILENAME = 'audio.wav';
// Response keys checked, in order, for the transcript and the detected language.
const STT_TRANSCRIPT_KEYS = ['transcript', 'text', 'transcription'];
const STT_LANGUAGE_KEYS = ['language_code', 'languageCode', 'language'];

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

// Read env lazily, never at module load: dotenv may not have run yet depending
// on import order.
function apiKey() {
  const key = process.env.SARVAM_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

function timeoutMs(fallback) {
  const raw = Number(process.env.SARVAM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Model IDs, overridable from the environment.
 *
 * Sarvam has now retired a model out from under this service twice — bulbul:v2
 * for TTS, saarika:v2 for STT — and each time the whole feature failed while
 * the API key was perfectly valid. Both times the fix was a one-word change
 * that still cost a code edit, a commit and a redeploy.
 *
 * Reading these from the environment means the next retirement is a variable
 * change in the Railway dashboard and a restart. The defaults above stay the
 * source of truth for a fresh checkout.
 */
export function ttsModel() {
  const raw = process.env.SARVAM_TTS_MODEL;
  return raw && raw.trim() ? raw.trim() : TTS_DEFAULT_MODEL;
}

export function sttModel() {
  const raw = process.env.SARVAM_STT_MODEL;
  return raw && raw.trim() ? raw.trim() : STT_DEFAULT_MODEL;
}

export function ttsSpeaker() {
  const raw = process.env.SARVAM_TTS_SPEAKER;
  return raw && raw.trim() ? raw.trim() : TTS_DEFAULT_SPEAKER;
}

export function isSarvamConfigured() {
  return apiKey() !== null;
}


/* ------------------------------------------------------------------ *
 * Credential health
 *
 * `isSarvamConfigured()` answers "is a key present", which is NOT the same as
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
      'Sarvam rejected the API key (HTTP ' + status + '). Check SARVAM_API_KEY in server/.env.';
    return;
  }
  if (status >= 200 && status < 300) {
    credentialRejected = false;
    lastRejectionDetail = null;
  }
}

/** True only when a key is present AND has not been rejected by the upstream. */
export function isSarvamUsable() {
  return isSarvamConfigured() && !credentialRejected;
}

/** Why it is unusable, or null. Safe to show: contains no key material. */
export function sarvamCredentialError() {
  if (!isSarvamConfigured()) return 'SARVAM_API_KEY is not set in server/.env.';
  return lastRejectionDetail;
}

function requireKey(where) {
  if (!isSarvamConfigured()) {
    throw new Error(
      `Sarvam unavailable: SARVAM_API_KEY is not set on the server (needed by ${where}). ` +
        'Add SARVAM_API_KEY to server/.env — see .env.example.',
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

/** Error naming Sarvam and the failing operation, carrying the HTTP status. */
class SarvamError extends Error {
  constructor(message, { status = null, retryable = false, body = '' } = {}) {
    super(message);
    this.name = 'SarvamError';
    this.service = 'sarvam';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

/**
 * POST to Sarvam with timeout + bounded retry.
 *
 * @param {string} url
 * @param {object} args
 * @param {object|FormData} args.body JSON-serialisable object, or a FormData
 *   (left untouched so fetch can set its own multipart boundary)
 * @param {string} args.label operation name used in error messages ('TTS'/'STT')
 * @param {number} args.timeout
 * @returns {Promise<object>} parsed JSON response
 */
async function sarvamRequest(url, { body, label, timeout }) {
  requireKey(`Sarvam ${label}`);

  const isMultipart = typeof FormData !== 'undefined' && body instanceof FormData;
  const limit = timeoutMs(timeout);
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          [SARVAM_AUTH_HEADER]: apiKey(),
          // Never set Content-Type for multipart: fetch must add the boundary.
          ...(isMultipart ? {} : { 'Content-Type': 'application/json' }),
        },
        body: isMultipart ? body : JSON.stringify(body),
        signal: controller.signal,
      });

      recordOutcome(response.status);

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new SarvamError(
          `Sarvam ${label} failed (HTTP ${response.status}): ${truncate(errBody)}`,
          {
            status: response.status,
            retryable: RETRY_STATUSES.has(response.status),
            body: truncate(errBody),
          },
        );
      }

      const raw = await response.text();
      try {
        return raw ? JSON.parse(raw) : {};
      } catch {
        throw new SarvamError(
          `Sarvam ${label} returned a non-JSON response: ${truncate(raw)}`,
          { status: response.status },
        );
      }
    } catch (err) {
      const isAbort = err && err.name === 'AbortError';
      const isNetwork = !(err instanceof SarvamError) && !isAbort;

      lastError =
        err instanceof SarvamError
          ? err
          : new SarvamError(
              isAbort
                ? `Sarvam ${label} timed out after ${limit}ms`
                : `Sarvam ${label} network error: ${truncate(err && err.message)}`,
              { retryable: true },
            );

      const retryable = lastError.retryable || isAbort || isNetwork;
      if (!retryable || attempt === MAX_ATTEMPTS) break;

      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleep(delay + Math.floor(Math.random() * 200));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new SarvamError(`Sarvam ${label} failed for an unknown reason`);
}

/* ------------------------------------------------------------------ */
/* text to speech                                                      */
/* ------------------------------------------------------------------ */

/**
 * Split text into speakable chunks on sentence boundaries.
 * Handles the Devanagari danda (।) as well as ASCII sentence enders; falls
 * back to a hard slice only for a single sentence longer than the cap.
 */
function chunkForSpeech(text, maxChars = TTS_MAX_CHARS_PER_CHUNK) {
  const clean = String(text == null ? '' : text).trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];

  // Keep the terminator attached to the sentence it ends.
  const sentences = clean.match(/[^।!?.\n]+[।!?.\n]*\s*/g) || [clean];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      // One runaway sentence: flush, then hard-slice it.
      if (current.trim()) chunks.push(current.trim());
      current = '';
      for (let i = 0; i < sentence.length; i += maxChars) {
        chunks.push(sentence.slice(i, i + maxChars).trim());
      }
      continue;
    }
    if ((current + sentence).length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.filter(Boolean);
}

/**
 * Synthesise speech.
 *
 * Keeps the known-good request shape: POST /text-to-speech with
 * { inputs: [text], target_language_code, model, speaker } and a response of
 * { audios: [base64] }.
 *
 * @param {string} text
 * @param {string} [languageCode='hi-IN']
 * @param {object} [opts] { speaker, model, pace, pitch, loudness }
 * @returns {Promise<string|null>} base64 audio, or null if Sarvam returned none
 * @throws {SarvamError} naming Sarvam TTS, so callers can fall back to audio:null
 */
export async function textToSpeech(text, languageCode = 'hi-IN', opts = {}) {
  const input = String(text == null ? '' : text).trim();
  if (!input) return null;

  const chunks = chunkForSpeech(input);
  if (!chunks.length) return null;

  // We send up to TTS_MAX_INPUTS_PER_REQUEST chunks in one request (the API
  // takes an array), but the contract returns a single clip, so only the first
  // is played. Say so in the log — never drop content silently.
  const sent = chunks.slice(0, TTS_MAX_INPUTS_PER_REQUEST);
  if (chunks.length > 1) {
    const spokenChars = chunks[0].length;
    console.warn(
      `[sarvam] TTS input was ${input.length} chars (> ${TTS_MAX_CHARS_PER_CHUNK}); ` +
        `split into ${chunks.length} chunks, ${sent.length} synthesised, ` +
        `only the first (${spokenChars} chars) is returned as audio. ` +
        `${input.length - spokenChars} chars will NOT be spoken — the full text is ` +
        'still returned to the client as text.',
    );
  }

  const body = {
    inputs: sent,
    target_language_code: languageCode,
    model: opts.model || ttsModel(),
    speaker: opts.speaker || ttsSpeaker(),
  };
  // Optional tuning knobs — only sent when the caller actually supplied them,
  // so we never push an unsupported field into a known-good request shape.
  if (opts.pace != null) body.pace = opts.pace;
  if (opts.pitch != null) body.pitch = opts.pitch;
  if (opts.loudness != null) body.loudness = opts.loudness;

  const data = await sarvamRequest(SARVAM_TTS_URL, {
    body,
    label: 'TTS',
    timeout: DEFAULT_TIMEOUT_MS,
  });

  // Sarvam returns a list of base64 clips under `audios`.
  const audio = data && Array.isArray(data.audios) ? data.audios[0] : null;
  if (!audio) {
    console.warn('[sarvam] TTS response contained no audio clip; returning null');
    return null;
  }
  return audio;
}

/* ------------------------------------------------------------------ */
/* speech to text                                                      */
/* ------------------------------------------------------------------ */

/** Accept a bare base64 string or a data: URL, and reject obvious garbage. */
function decodeAudio(audioBase64) {
  const raw = String(audioBase64 == null ? '' : audioBase64).trim();
  if (!raw) throw new SarvamError('Sarvam STT: audioBase64 is empty');

  const commaIdx = raw.startsWith('data:') ? raw.indexOf(',') : -1;
  const payload = commaIdx >= 0 ? raw.slice(commaIdx + 1) : raw;

  let buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch (err) {
    throw new SarvamError(`Sarvam STT: audio is not valid base64 (${truncate(err && err.message)})`);
  }
  if (!buffer.length) throw new SarvamError('Sarvam STT: decoded audio is zero bytes');
  return buffer;
}

/** First present, non-empty string among `keys` on `obj`. */
function pickString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Transcribe audio.
 *
 * POST /speech-to-text as multipart/form-data, built with Node 18+ global
 * FormData + Blob (no npm dependency). Field names live in the constants at the
 * top of this file — verify them against current Sarvam docs.
 *
 * @param {string} audioBase64 base64 (or data: URL) audio, wav/mp3/etc
 * @param {string} [languageCode='hi-IN']
 * @param {object} [opts] { model, mimeType, fileName }
 * @returns {Promise<{ transcript: string, languageCode: string }>}
 * @throws {SarvamError} naming Sarvam STT — never a silently wrong transcript
 */
export async function speechToText(audioBase64, languageCode = 'hi-IN', opts = {}) {
  requireKey('Sarvam STT');

  if (typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    throw new SarvamError(
      'Sarvam STT requires global FormData/Blob (Node 18+). Upgrade Node to use speech-to-text.',
    );
  }

  const buffer = decodeAudio(audioBase64);
  const mimeType = opts.mimeType || STT_DEFAULT_MIME;
  const fileName = opts.fileName || STT_DEFAULT_FILENAME;

  const form = new FormData();
  // Copy into a fresh Uint8Array: a Buffer is a view onto a pooled ArrayBuffer,
  // and handing that straight to Blob can include neighbouring bytes.
  form.append(
    STT_FILE_FIELD,
    new Blob([new Uint8Array(buffer)], { type: mimeType }),
    fileName,
  );
  form.append(STT_LANGUAGE_FIELD, languageCode);
  form.append(STT_MODEL_FIELD, opts.model || sttModel());

  const data = await sarvamRequest(SARVAM_STT_URL, {
    body: form,
    label: 'STT',
    timeout: STT_TIMEOUT_MS,
  });

  // Look at the top level, then at one common nesting, before giving up.
  const nested = (data && (data.result || data.data)) || null;
  const transcript = pickString(data, STT_TRANSCRIPT_KEYS) || pickString(nested, STT_TRANSCRIPT_KEYS);

  if (transcript == null) {
    // Degrade loudly. A wrong transcript would be turned into a device action,
    // so an empty/unknown shape must raise rather than return something plausible.
    throw new SarvamError(
      'Sarvam STT: no transcript field in the response ' +
        `(looked for ${STT_TRANSCRIPT_KEYS.join(', ')}). ` +
        `Verify the endpoint contract against current Sarvam docs. Response: ${truncate(
          JSON.stringify(data),
        )}`,
    );
  }

  return {
    transcript,
    languageCode:
      pickString(data, STT_LANGUAGE_KEYS) ||
      pickString(nested, STT_LANGUAGE_KEYS) ||
      languageCode,
  };
}
