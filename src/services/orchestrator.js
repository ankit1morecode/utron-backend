// ---------------------------------------------------------------------------
// ULTRON AIR — ASK -> UNDERSTAND -> ACT ORCHESTRATOR
// ---------------------------------------------------------------------------
// One turn of the product's core loop lives here:
//
//   VOICE -> (STT, done by the route) -> UNDERSTAND -> CONTEXT -> PLAN
//         -> PERMISSION GATE -> CONFIRM -> RESPOND    (-> TTS, done by the route)
//
// Each stage below is a separate, individually testable function, exported so
// routes and tests can drive them in isolation.
//
// THREE RULES THIS FILE ENFORCES, in priority order:
//
//   1. HONESTY. The server PLANS actions; the phone EXECUTES them. No reply
//      text here ever says an action happened. The only exception is a
//      server-executed intent (remember / recall / translate), which really did
//      run on this machine, or an explicit `context.lastActionResult` in which
//      the CLIENT reported what it actually did.
//
//   2. PRIVACY. The permission gate (`enforcePermissionGate`) fails CLOSED, and
//      the classifier prompt is built from an explicit allowlist of context
//      fields. Contact lists and notification bodies are never invented,
//      inferred, or forwarded — only what the client deliberately sent.
//
//   3. NEVER DIE. runTurn() cannot throw. Gemini down => rule-based offline
//      matcher (`matchIntentOffline`) with degraded:'no_language_model'. Store
//      down => store.js's own in-memory fallback, and every call here is
//      additionally wrapped so a broken dependency downgrades one feature
//      instead of killing the turn.
// ---------------------------------------------------------------------------

import {
  INTENT_NAMES,
  INTENT_REGISTRY,
  getIntent,
  describeIntentsForPrompt,
  PERMISSION_RATIONALE,
  EMERGENCY_CONFIRM_WINDOW_MS,
} from './intents.js';

// Namespace imports on purpose: a *named* ESM import of an export that a
// sibling module does not (yet) provide is a link-time error that takes down
// the whole server. With a namespace import a missing function is just
// undefined, which the guards below turn into a graceful degradation.
import * as gemini from './gemini.js';
import * as store from './store.js';

// --------------------------------------------------------------------------
// Tunables
// --------------------------------------------------------------------------

/** Below this the classifier's answer is not trustworthy enough to act on. */
export const CONFIDENCE_THRESHOLD = 0.5;

/** How long a plan waits for the user to say yes before it is forgotten. */
const PENDING_PLAN_TTL_MS = 2 * 60 * 1000;

/** How many past turns are shown to the classifier. */
const HISTORY_TURNS = 12;

/** How many memories may be injected as context. */
const MEMORY_MATCHES = 4;

let actionSeq = 0;

// --------------------------------------------------------------------------
// Pending-plan store (confirmation state)
// --------------------------------------------------------------------------
// A confirmable plan is held here between "Mom ko call karun?" and the user's
// "haan". In-process only: a restart loses pending confirmations, which is the
// safe direction to fail — a forgotten plan is never executed by accident.
const pendingPlans = new Map(); // userId -> { at, transcript, plan, actions, classification }

function rememberPendingPlan(userId, payload) {
  pendingPlans.set(userId, { at: Date.now(), ...payload });
}

/**
 * Read the pending plan, enforcing the TTL. An expired plan is dropped rather
 * than offered: "haan" ten minutes later must not place a call the user has
 * long forgotten about.
 */
function peekPendingPlan(userId) {
  const pending = pendingPlans.get(userId);
  if (!pending) return null;
  if (Date.now() - pending.at > PENDING_PLAN_TTL_MS) {
    pendingPlans.delete(userId);
    return null;
  }
  return pending;
}

/** Exposed so a route (or a test) can drop a pending confirmation explicitly. */
export function clearPendingPlan(userId) {
  return pendingPlans.delete(userId);
}

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

const AFFIRMATIVE = /^(haan|han|ha|haa|ji|ji haan|yes|yeah|yep|yup|ok|okay|theek hai|thik hai|sahi|kar do|karo|do it|confirm|bilkul)\b/i;
const NEGATIVE = /^(nahi|nahin|na|no|nope|cancel|ruko|ruk ja|rehne do|band karo|stop|abort|mat karo)\b/i;

/** 'hi-IN' -> 'hi'. Used to pick the canned-phrase table. */
function langOf(languageCode) {
  return String(languageCode || 'hi-IN').slice(0, 2).toLowerCase();
}

/**
 * Canned phrases.
 *
 * Only Hinglish and English are hand-written. Other Indian languages currently
 * fall back to English for these fixed strings — model-generated replies are
 * already produced in the user's language, so this only affects the small set
 * of system messages. Localising them is a Phase 2 task, tracked deliberately
 * rather than faked.
 */
const PHRASES = {
  hi: {
    emptyInput: 'Maine kuch suna nahi. Dobara boliye — jaise "Mom ko call karo".',
    unknown:
      'Ye samajh nahi aaya. Aise bol kar dekhiye — "Mom ko call karo", "awaaz badhao", ya "battery kitni hai".',
    whoToCall: 'Kis ko call karun? Naam boliye.',
    contactNotFound: (q) => `"${q}" naam ka contact nahi mila. Poora naam boliye.`,
    contactChoose: (list) => `Kai contacts mile — ${list}. In mein se kis ko call karun?`,
    confirmCall: (n) => `${n} ko call karun?`,
    confirmGeneric: (d) => `${d} — karun?`,
    confirmEmergency: (n) =>
      `Emergency call ${n} ko ${Math.round(EMERGENCY_CONFIRM_WINDOW_MS / 1000)} second mein ja rahi hai. Rokna ho to "cancel" boliye.`,
    cancelled: 'Theek hai, cancel kar diya.',
    permission: (need, why) =>
      `Iske liye mujhe ${need} chahiye${why ? `, ${why}` : ''}. App mein allow kar dijiye, phir main kar dunga.`,
    remembered: 'Yaad rakh liya.',
    nothingRemembered: 'Is baare mein mujhe kuch yaad nahi hai.',
    recallIntro: 'Aapne ye bataya tha:',
    plannedFeature:
      'Ye feature abhi nahi aaya — hum is par kaam kar rahe hain. Filhaal main call, music, translate aur notifications sambhal sakta hoon.',
    noModel:
      'Internet ya AI service abhi nahi mil rahi, isliye main sirf basic commands samajh sakta hoon — call, volume, gaana, battery.',
    translateFailed: 'Translation abhi nahi ho paayi. Thodi der baad dobara boliye.',
    error: 'Kuch gadbad ho gayi. Dobara boliye.',
    safetyNote:
      'Dhyan rahe — abhi main siren ya horn identify nahi karta, wo capability aane wali hai.',
    actionDone: (what) => `${what} ho gaya.`,
    actionFailed: (what) => `${what} nahi ho paaya.`,
  },
  en: {
    emptyInput: 'I did not catch that. Try again — for example "call Mom".',
    unknown:
      'I did not follow that. Try something like "call Mom", "turn the volume up", or "how much battery is left".',
    whoToCall: 'Who should I call? Say the name.',
    contactNotFound: (q) => `I could not find a contact called "${q}". Say the full name.`,
    contactChoose: (list) => `I found a few — ${list}. Which one should I call?`,
    confirmCall: (n) => `Call ${n}?`,
    confirmGeneric: (d) => `${d} — should I?`,
    confirmEmergency: (n) =>
      `Emergency call to ${n} in ${Math.round(EMERGENCY_CONFIRM_WINDOW_MS / 1000)} seconds. Say "cancel" to stop it.`,
    cancelled: 'Okay, cancelled.',
    permission: (need, why) =>
      `For that I need ${need}${why ? `, ${why}` : ''}. Allow it in the app and I can go ahead.`,
    remembered: 'Saved that.',
    nothingRemembered: 'I do not have anything saved about that.',
    recallIntro: 'You told me:',
    plannedFeature:
      'That feature is not available yet — we are still building it. For now I can handle calls, music, translation and notifications.',
    noModel:
      'I cannot reach the AI service right now, so I can only handle basic commands — calls, volume, music, battery.',
    translateFailed: 'I could not translate that right now. Try again in a moment.',
    error: 'Something went wrong. Say that again.',
    safetyNote:
      'Note: I cannot identify sirens or horns yet — that capability is planned.',
    actionDone: (what) => `${what} done.`,
    actionFailed: (what) => `${what} did not go through.`,
  },
};

function phrases(languageCode) {
  return PHRASES[langOf(languageCode)] || PHRASES.en;
}

/** Wrap a dependency call so a broken sibling module degrades one feature. */
async function safely(label, fn, fallbackValue) {
  try {
    const value = await fn();
    return value;
  } catch (err) {
    console.warn(`[orchestrator] ${label} failed: ${err?.message || err}`);
    return fallbackValue;
  }
}

function newAction(intent, params, extra = {}) {
  const entry = getIntent(intent) || INTENT_REGISTRY.unknown;
  return {
    id: `act_${Date.now().toString(36)}_${actionSeq++}`,
    intent: entry.name,
    params: params || {},
    requiresConfirmation: Boolean(entry.requiresConfirmation),
    requiredPermissions: resolveRequiredPermissions(entry, params),
    executedBy: entry.executedBy,
    status: 'planned',
    ...extra,
  };
}

/**
 * Permissions an action actually needs, including conditional ones — e.g.
 * call_emergency only needs 'location' when the user asked to share location.
 */
export function resolveRequiredPermissions(intentOrName, params = {}) {
  const entry =
    typeof intentOrName === 'string' ? getIntent(intentOrName) : intentOrName;
  if (!entry) return [];

  const required = new Set(entry.requiredPermissions || []);
  const conditional = entry.conditionalPermissions || {};
  for (const [param, perms] of Object.entries(conditional)) {
    if (params && params[param]) perms.forEach((p) => required.add(p));
  }
  return [...required];
}

/** A blank TurnResult with every contract field present. */
function emptyResult(transcript) {
  return {
    transcript: transcript || '',
    intent: 'unknown',
    confidence: 0,
    contextUsed: {},
    plan: [],
    actions: [],
    reply: '',
    needsConfirmation: false,
    needsPermission: [],
    followUp: null,
    fallback: false,
    error: null,
    degraded: null,
  };
}

// ==========================================================================
// STAGE (b) — CONTEXT
// ==========================================================================
// Assemble exactly what the model is allowed to see. This is an ALLOWLIST, not
// a filter: anything the client sends that is not named here simply never
// reaches the language model. Contact lists and notification bodies are not in
// the allowlist; the only contact strings that pass through are the near-match
// candidates the client deliberately supplied to resolve an ambiguous name.
// ==========================================================================

export async function buildContext({ userId, text, languageCode, context = {} }) {
  const recentTurns = await safely(
    'conversations.recent',
    () => store.conversations?.recent?.(userId, HISTORY_TURNS),
    [],
  );

  const matchedMemories = await safely(
    'memories.search',
    () => store.memories?.search?.(userId, text, MEMORY_MATCHES),
    [],
  );

  const device = context.device || {};

  return {
    languageCode,
    // Conversation memory (oldest first) — normalised into a flat shape so the
    // prompt builder does not care how store.js shaped its documents.
    recentTurns: (Array.isArray(recentTurns) ? recentTurns : [])
      .slice(-HISTORY_TURNS)
      .map((turn) => ({
        role: turn?.role === 'assistant' || turn?.role === 'model' ? 'assistant' : 'user',
        text: String(turn?.text ?? turn?.content ?? turn?.message ?? '').slice(0, 400),
      }))
      .filter((turn) => turn.text),

    memories: (Array.isArray(matchedMemories) ? matchedMemories : [])
      .slice(0, MEMORY_MATCHES)
      .map((memory) => String(memory?.text ?? memory ?? '').slice(0, 300))
      .filter(Boolean),

    // ---- client-supplied device/session state (allowlisted) ----
    connection: context.connection ?? device.connection ?? null, // 'connected' | 'disconnected'
    battery: context.battery ?? device.battery ?? null,
    playback: context.playback ?? null, // { state, track }
    noiseMode: context.noiseMode ?? device.noiseControl ?? null,
    drivingMode: Boolean(context.drivingMode),
    safetyMode: Boolean(context.safetyMode),
    inCall: Boolean(context.inCall),
    incomingCall: context.incomingCall ?? null, // { from } — client-provided only
    grantedPermissions: [...resolveGrantedPermissions(context)],
    offline: Boolean(context.offline),

    // Contact disambiguation: candidate names the CLIENT sent for THIS turn.
    // We never hold or request the address book.
    contactResolution: normaliseContactResolution(context),

    // Notification info is passed through only when the client sent it.
    notificationSummary:
      typeof context.notificationSummary === 'string'
        ? context.notificationSummary.slice(0, 500)
        : null,

    // What the phone reported about the last action it tried to run. This is
    // the ONLY source that lets a reply claim something actually happened.
    lastActionResult: context.lastActionResult ?? null,
  };
}

function normaliseContactResolution(context) {
  const raw = context.contactResolution || null;
  const nearMatches = Array.isArray(context.nearMatches) ? context.nearMatches : null;

  if (!raw && !nearMatches) return null;

  const candidates = (raw?.candidates || nearMatches || [])
    .map((candidate) =>
      typeof candidate === 'string' ? candidate : candidate?.name || '',
    )
    .filter(Boolean)
    .slice(0, 5);

  return {
    status: raw?.status || (candidates.length ? 'ambiguous' : 'not_found'),
    query: raw?.query || null,
    candidates,
  };
}

/**
 * Which permissions the client says it holds.
 * Accepts either ['contacts','phone'] or { contacts: true, phone: false }.
 *
 * FAILS CLOSED: if the client sent nothing, we assume nothing is granted. An
 * unverifiable permission is a denied permission — that is the whole promise.
 * ULTRON_ASSUME_PERMISSIONS exists only for local development against a client
 * that does not report permission state yet; never set it in production.
 */
function resolveGrantedPermissions(context = {}) {
  const raw = context.grantedPermissions ?? context.permissions;

  if (Array.isArray(raw)) {
    return new Set(raw.filter((p) => typeof p === 'string'));
  }
  if (raw && typeof raw === 'object') {
    return new Set(
      Object.entries(raw)
        .filter(([, value]) => value === true || value === 'granted')
        .map(([key]) => key),
    );
  }

  const assumed = process.env.ULTRON_ASSUME_PERMISSIONS;
  if (assumed) {
    return new Set(assumed.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return new Set();
}

// ==========================================================================
// STAGE (a) — UNDERSTAND
// ==========================================================================

// Every param name used anywhere in the registry, with its type. Declaring the
// union explicitly keeps the response schema valid for Gemini's responseSchema
// (a bare untyped object is often rejected) and lets us drop hallucinated keys.
const PARAM_TYPES = (() => {
  const types = {};
  for (const intent of Object.values(INTENT_REGISTRY)) {
    for (const [key, type] of Object.entries(intent.params || {})) types[key] = type;
  }
  return types;
})();

const PARAM_SCHEMA_PROPERTIES = Object.fromEntries(
  Object.entries(PARAM_TYPES).map(([key, type]) => [key, { type }]),
);

const CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENT_NAMES },
    confidence: { type: 'number' },
    params: { type: 'object', properties: PARAM_SCHEMA_PROPERTIES },
    isMultiStep: { type: 'boolean' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          intent: { type: 'string', enum: INTENT_NAMES },
          description: { type: 'string' },
          params: { type: 'object', properties: PARAM_SCHEMA_PROPERTIES },
        },
      },
    },
    clarificationNeeded: { type: 'boolean' },
    clarificationQuestion: { type: 'string' },
    replyDraft: { type: 'string' },
  },
  required: ['intent', 'confidence'],
};

const CLASSIFIER_SYSTEM = [
  'You are the intent classifier and planner inside ULTRON AIR, an AI earbuds assistant used in India.',
  'You convert one spoken command into structured JSON. You never execute anything and you never claim anything was done.',
  'Users mix Hindi, English and Hinglish freely. Treat Hinglish as Hindi.',
  'Rules:',
  '1. Pick exactly one intent from the list, or "unknown" if nothing fits.',
  '2. confidence is your honest 0-1 probability that the intent AND params are right. Be strict: use below 0.5 when the command is vague, half-heard, or could be two different things.',
  '3. Fill only params that the user actually said. Never invent a contact name, a phone number, a destination or a song.',
  '4. If the user chained requests ("call Mom and put it on speaker", "gaana band karo aur battery batao"), set isMultiStep true and list steps in the order spoken.',
  '5. Set clarificationNeeded true with a short clarificationQuestion when a required detail is missing (e.g. "call" with no name).',
  '6. replyDraft is a SHORT spoken answer in the user\'s language. For device actions it must only acknowledge the request, never report success. For a general question, replyDraft is the actual answer.',
  '7. Anything about danger, accident, help, bachao, madad, or medical emergency is call_emergency.',
  'Reply with JSON only.',
].join('\n');

/**
 * STAGE (a): classify one utterance against the registry.
 * Throws on model failure so runTurn() can fall back to the offline matcher.
 */
export async function understand({ userId, text, languageCode, contextUsed }) {
  if (typeof gemini.generateStructured !== 'function') {
    throw new Error('gemini.generateStructured is unavailable');
  }
  if (typeof gemini.isGeminiConfigured === 'function' && !gemini.isGeminiConfigured()) {
    throw new Error('Gemini is not configured');
  }

  const promptParts = [
    'INTENTS:',
    describeIntentsForPrompt(),
    '',
    `USER LANGUAGE: ${languageCode}`,
  ];

  if (contextUsed.memories.length) {
    promptParts.push(
      '',
      'THINGS THE USER ASKED ME TO REMEMBER (use only if relevant):',
      ...contextUsed.memories.map((memory) => `- ${memory}`),
    );
  }

  // Device/session facts the classifier may use for reference resolution
  // ("band karo" means pause only if something is playing).
  const state = [];
  if (contextUsed.playback) state.push(`playback=${JSON.stringify(contextUsed.playback)}`);
  if (contextUsed.connection) state.push(`earbuds=${contextUsed.connection}`);
  if (contextUsed.battery !== null) state.push(`battery=${contextUsed.battery}`);
  if (contextUsed.inCall) state.push('inCall=true');
  if (contextUsed.incomingCall) state.push('incomingCall=true');
  if (contextUsed.drivingMode) state.push('driving=true');
  if (state.length) promptParts.push('', `DEVICE STATE: ${state.join(', ')}`);

  if (contextUsed.contactResolution?.candidates?.length) {
    promptParts.push(
      '',
      `CONTACT CANDIDATES THE PHONE OFFERED: ${contextUsed.contactResolution.candidates.join(', ')}`,
    );
  }
  if (contextUsed.notificationSummary) {
    promptParts.push('', `NOTIFICATIONS THE PHONE SENT: ${contextUsed.notificationSummary}`);
  }

  promptParts.push('', `USER SAID: ${text}`);

  // Conversation history goes in as Gemini-shaped turns, not as prompt text, so
  // the model treats it as dialogue rather than instructions.
  const history = contextUsed.recentTurns.map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.text }],
  }));

  const raw = await gemini.generateStructured({
    systemInstruction: CLASSIFIER_SYSTEM,
    prompt: promptParts.join('\n'),
    schema: CLASSIFICATION_SCHEMA,
    history,
  });

  return normaliseClassification(raw, text);
}

/** Coerce whatever the model returned into the classification contract. */
function normaliseClassification(raw, text) {
  const source = raw && typeof raw === 'object' ? raw : {};

  let intent = getIntent(source.intent) ? source.intent.trim() : 'unknown';
  let confidence = Number(source.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.min(1, Math.max(0, confidence));

  // Low confidence is not a guess we are willing to act on.
  if (confidence < CONFIDENCE_THRESHOLD) intent = 'unknown';

  const steps = Array.isArray(source.steps)
    ? source.steps
        .filter((step) => getIntent(step?.intent))
        .map((step) => ({
          intent: step.intent.trim(),
          description: String(step.description || '').slice(0, 160),
          params: coerceParams(step.intent, step.params),
        }))
    : [];

  return {
    intent,
    confidence,
    params: coerceParams(intent, source.params),
    isMultiStep: Boolean(source.isMultiStep) && steps.length > 1,
    steps,
    clarificationNeeded: Boolean(source.clarificationNeeded),
    clarificationQuestion: String(source.clarificationQuestion || '').slice(0, 200),
    replyDraft: String(source.replyDraft || '').slice(0, 600),
    rawText: text,
  };
}

/** Keep only params the intent declares, coerced to the declared type. */
function coerceParams(intentName, params) {
  const entry = getIntent(intentName);
  if (!entry || !params || typeof params !== 'object') return {};

  const out = {};
  for (const [key, type] of Object.entries(entry.params || {})) {
    const value = params[key];
    if (value === undefined || value === null || value === '') continue;

    if (type === 'number') {
      const num = Number(value);
      if (Number.isFinite(num)) out[key] = num;
    } else if (type === 'boolean') {
      out[key] = value === true || value === 'true' || value === 1;
    } else {
      out[key] = String(value).slice(0, 300);
    }
  }
  return out;
}

// ==========================================================================
// STAGE (g, partial) — RULE-BASED OFFLINE INTENT MATCHER
// ==========================================================================
// Used whenever the language model is unreachable, unconfigured, or returns
// garbage. Exported so the mobile app's docs can publish exactly this command
// list as "commands that work without internet". Hindi/Hinglish first, because
// that is what the target user actually says.
// ==========================================================================

/**
 * The offline command list. Each entry: { intent, examples, match(text) }.
 * `match` returns a params object (possibly empty) or null.
 * ORDER MATTERS — emergency is tested first, and "band karo" must be checked
 * before generic music handling so it can mean "pause".
 */
export const OFFLINE_COMMANDS = [
  {
    intent: 'call_emergency',
    examples: ['emergency', 'call emergency', 'bachao', 'madad karo', 'help me'],
    match: (t) =>
      /\b(emergency|sos|bachao|bachaao|madad|help me|accident|ambulance)\b/i.test(t)
        ? { reason: 'voice trigger' }
        : null,
  },
  {
    intent: 'answer_call',
    examples: ['answer', 'pick up', 'call uthao'],
    match: (t) =>
      /\b(answer|pick up|attend|uthao|utha lo|receive)\b.*\b(call|phone)?\b/i.test(t) &&
      /\b(answer|pick up|attend|uthao|utha lo|receive)\b/i.test(t)
        ? {}
        : null,
  },
  {
    intent: 'reject_call',
    examples: ['reject call', 'call kaat do', 'decline'],
    match: (t) =>
      /\b(reject|decline|cut the call|call kaat|kaat do|mat uthao)\b/i.test(t) ? {} : null,
  },
  {
    intent: 'end_call',
    examples: ['hang up', 'end call', 'call band karo'],
    match: (t) => (/\b(hang up|end call|call end|call band)\b/i.test(t) ? {} : null),
  },
  {
    intent: 'call_contact',
    examples: ['call Mom', 'Mummy ko call karo', 'papa ko phone lagao'],
    match: (t) => {
      const input = t.trim();

      // Hindi word order FIRST: "Mummy ko call karo", "papa ko phone lagao".
      // Tested before the English pattern because "call karo" would otherwise
      // capture the verb "karo" as if it were a name.
      let m = /^([a-zऀ-ॿ][a-zऀ-ॿ\s.']{0,40}?)\s+ko\s+(?:call|phone|fone)\s*(?:karo|kar do|kardo|lagao|laga do|milao)?\b/i.exec(
        input,
      );
      let name = m && m[1] ? cleanName(m[1]) : '';
      if (isUsableName(name)) return { contactName: name };

      // "call X" / "phone X" / "dial X"
      m = /\b(?:call|phone|dial)\s+(?:to\s+)?([a-zऀ-ॿ][a-zऀ-ॿ\s.']{0,40}?)(?:\s+(?:karo|kar do|kardo|lagao|laga do|please|now))?$/i.exec(
        input,
      );
      name = m && m[1] ? cleanName(m[1]) : '';
      if (isUsableName(name)) return { contactName: name };

      // A bare "call karo" with no name is still a call intent — the pipeline
      // will ask who, which is better than silently matching nothing.
      if (/^(?:call|phone|dial)\b/i.test(input) || /\bcall\s+(?:karo|kar do|lagao)\b/i.test(input)) {
        return {};
      }
      return null;
    },
  },
  {
    intent: 'set_volume',
    examples: ['volume up', 'awaaz badhao', 'volume 50', 'awaaz kam karo'],
    match: (t) => {
      const level = /\bvolume\s+(?:ko\s+)?(\d{1,3})\b/i.exec(t);
      if (level) return { level: Math.min(100, Number(level[1])) };
      if (/\b(volume up|louder|awaaz badhao|awaz badhao|aawaz badhao|tez karo|volume badhao|increase volume)\b/i.test(t))
        return { direction: 'up' };
      if (/\b(volume down|quieter|softer|awaaz kam|awaz kam|dheere karo|volume kam|decrease volume|lower the volume)\b/i.test(t))
        return { direction: 'down' };
      return null;
    },
  },
  {
    intent: 'next_track',
    examples: ['next', 'next song', 'agla gana'],
    match: (t) =>
      /\b(next|skip|agla gana|agla gaana|aage badhao|next track|next song)\b/i.test(t) ? {} : null,
  },
  {
    intent: 'previous_track',
    examples: ['previous', 'pichla gana', 'go back'],
    match: (t) =>
      /\b(previous|pichla gana|pichla gaana|peeche|last song|previous track)\b/i.test(t) ? {} : null,
  },
  {
    intent: 'pause_music',
    examples: ['pause', 'stop', 'band karo', 'gana band karo'],
    match: (t) =>
      /\b(pause|stop the music|stop music|music band|gana band|gaana band|band karo|ruko|rok do)\b/i.test(t)
        ? {}
        : null,
  },
  {
    intent: 'play_music',
    examples: ['play music', 'gana chalao', 'play Arijit Singh'],
    match: (t) => {
      const named = /\b(?:play|chalao|laga do|lagao)\s+(?!music|gana|gaana)([a-z0-9ऀ-ॿ][^,.]{0,60}?)(?:\s+(?:gana|gaana|song|chalao|lagao))?$/i.exec(
        t.trim(),
      );
      if (named && named[1]) return { query: named[1].trim() };
      if (/\b(play music|play song|music chalao|gana chalao|gaana chalao|resume|music start)\b/i.test(t))
        return {};
      return null;
    },
  },
  {
    intent: 'battery_status',
    examples: ['battery', 'battery kitni hai', 'how much battery'],
    match: (t) =>
      /\b(battery|charge kitna|kitni battery|battery kitni|power left)\b/i.test(t) ? {} : null,
  },
  {
    intent: 'device_status',
    examples: ['status', 'earbuds connected hai'],
    match: (t) =>
      /\b(device status|earbud status|connected hai|connection status|status batao)\b/i.test(t)
        ? {}
        : null,
  },
  {
    intent: 'find_earbuds',
    examples: ['find my earbuds', 'earbuds kahan hai'],
    match: (t) =>
      /\b(find (my )?(earbuds|buds)|earbuds kahan|buds kahan|locate earbuds)\b/i.test(t)
        ? {}
        : null,
  },
  {
    intent: 'set_noise_mode',
    examples: ['noise cancellation on', 'transparency mode', 'anc band karo'],
    match: (t) => {
      if (/\b(transparency|ambient|aas paas sunao|pass through)\b/i.test(t))
        return { mode: 'transparency' };
      if (/\b(noise cancel\w*|anc)\b/i.test(t))
        return { mode: /\b(off|band|hata|disable)\b/i.test(t) ? 'off' : 'anc' };
      return null;
    },
  },
  {
    intent: 'translate',
    examples: ['translate to English', 'iska hindi mein translate karo'],
    match: (t) => {
      // "translate <text> to <lang>" / "<text> ko <lang> mein translate karo"
      let m = /\btranslate\s+(?:this\s+)?(?:"?(.+?)"?\s+)?(?:in|into|to)\s+([a-zऀ-ॿ]+)/i.exec(t);
      if (m) return { text: (m[1] || '').trim(), targetLanguage: m[2].trim() };
      m = /^(.+?)\s+ka\s+([a-zऀ-ॿ]+)\s+(?:mein|me)\s+(?:matlab|translate|anuvaad)/i.exec(t);
      if (m) return { text: m[1].trim(), targetLanguage: m[2].trim() };
      if (/\btranslate (karo|kar do)\b/i.test(t)) return {};
      return null;
    },
  },
  {
    intent: 'read_notifications',
    examples: ['read my notifications', 'notification padho'],
    match: (t) =>
      /\b(notification|notifications|messages? (padho|sunao|read)|padho notification)\b/i.test(t)
        ? {}
        : null,
  },
  {
    intent: 'safety_mode',
    examples: ['safety mode on', 'safety mode band karo'],
    match: (t) => {
      if (!/\bsafety\s*mode\b/i.test(t)) return null;
      return { enabled: !/\b(off|band|disable|hata)\b/i.test(t) };
    },
  },
  {
    intent: 'remember',
    examples: ['remember that...', 'yaad rakho...'],
    match: (t) => {
      const m = /\b(?:remember (?:that )?|yaad rakho|yaad rakhna|note kar lo)\s*(.+)$/i.exec(t);
      return m && m[1] ? { text: m[1].trim() } : null;
    },
  },
  {
    intent: 'recall',
    examples: ['what did I tell you about...', 'kya yaad hai'],
    match: (t) => {
      const m = /\b(?:what did i (?:say|tell you) about|kya yaad hai|yaad hai kya|recall)\s*(.*)$/i.exec(t);
      return m ? { query: (m[1] || '').trim() } : null;
    },
  },
];

function cleanName(raw) {
  return raw
    .replace(/\b(please|now|abhi|jaldi|karo|kar do|kardo|lagao|laga do|milao|do)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reject verb fragments that the loose regexes can capture instead of a name. */
const NAME_STOPWORDS = new Set([
  'call', 'phone', 'fone', 'dial', 'karo', 'kar', 'kardo', 'lagao', 'laga',
  'milao', 'do', 'ko', 'please', 'now', 'abhi',
]);

function isUsableName(name) {
  if (!name || name.length < 2) return false;
  return !NAME_STOPWORDS.has(name.toLowerCase());
}

/**
 * Rule-based intent matching with no network and no model.
 * Returns a classification in the same shape `understand()` produces, so the
 * rest of the pipeline cannot tell the difference.
 */
export function matchIntentOffline(text) {
  const input = String(text || '').trim();
  const blank = {
    intent: 'unknown',
    confidence: 0,
    params: {},
    isMultiStep: false,
    steps: [],
    clarificationNeeded: false,
    clarificationQuestion: '',
    replyDraft: '',
    rawText: input,
  };
  if (!input) return blank;

  // Multi-step: "call Mom and put it on speaker", "gana band karo aur battery batao".
  const segments = input
    .split(/\s+(?:and then|then|and|aur|phir|uske baad)\s+/i)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .slice(0, 3);

  const matched = [];
  for (const segment of segments) {
    const hit = matchSegment(segment);
    if (hit) matched.push(hit);
  }

  // Whole-string match is more reliable than fragments when only one thing hit.
  const whole = matchSegment(input);

  if (matched.length > 1) {
    return {
      ...blank,
      intent: matched[0].intent,
      confidence: 0.6,
      params: matched[0].params,
      isMultiStep: true,
      steps: matched.map((hit) => ({
        intent: hit.intent,
        description: hit.segment,
        params: hit.params,
      })),
    };
  }

  const best = whole || matched[0];
  if (!best) return blank;

  return {
    ...blank,
    intent: best.intent,
    // Deliberately below a model's typical score: this is pattern matching, not
    // understanding. Still above CONFIDENCE_THRESHOLD so it is actionable.
    confidence: 0.65,
    params: best.params,
  };
}

function matchSegment(segment) {
  for (const command of OFFLINE_COMMANDS) {
    let params = null;
    try {
      params = command.match(segment);
    } catch {
      params = null; // a bad regex must never take down a turn
    }
    if (params) return { intent: command.intent, params: coerceParams(command.intent, params), segment };
  }
  return null;
}

// ==========================================================================
// STAGE (c) — PLAN
// ==========================================================================

/**
 * Turn a classification into an ordered plan + actions[]. Multi-step commands
 * produce one plan entry and one action per step, in spoken order; each action
 * carries its own permissions and confirmation requirement from the registry.
 */
export function buildPlan(classification) {
  const steps =
    classification.isMultiStep && classification.steps.length
      ? classification.steps
      : [
          {
            intent: classification.intent,
            description: '',
            params: classification.params,
          },
        ];

  const plan = [];
  const actions = [];

  steps.forEach((step, index) => {
    const entry = getIntent(step.intent) || INTENT_REGISTRY.unknown;
    const params = step.params || {};

    plan.push({
      step: index + 1,
      description: step.description || entry.description,
      intent: entry.name,
      params,
    });

    // 'unknown' is a conversational outcome, not something to execute.
    if (entry.name === 'unknown') return;

    const action = newAction(entry.name, params);

    // Planned-but-unbuilt capabilities (phase 4 vision) never become runnable,
    // and are marked before the permission gate: asking for camera access for a
    // feature that does not exist would be dishonest.
    if (entry.implemented === false) action.status = 'unavailable';

    // Emergency carries its cancel window so the client can run a countdown
    // instead of a dialogue.
    if (entry.name === 'call_emergency') action.cancelWindowMs = EMERGENCY_CONFIRM_WINDOW_MS;

    actions.push(action);
  });

  return { plan, actions };
}

// ==========================================================================
// STAGE (d) — PERMISSION GATE   *** the privacy promise lives here ***
// ==========================================================================

/**
 * enforcePermissionGate — the single chokepoint between a planned action and a
 * runnable one.
 *
 * For every action, every permission it needs (including conditional ones) must
 * appear in the set the CLIENT reported as granted. If even one is missing the
 * action is marked 'blocked_permission' and is never emitted as runnable; the
 * caller turns that into a spoken explanation of what is needed and why.
 *
 * Properties this function must keep:
 *   - It fails CLOSED. Unknown permission state == not granted.
 *   - It is the ONLY place an action becomes runnable. Nothing else may set
 *     status to 'ready'.
 *   - It never consults a server-side cache of "what we granted last time":
 *     permissions can be revoked on the phone at any moment, so only this
 *     turn's client-reported state counts.
 *
 * Mutates and returns the actions, plus the de-duplicated list of missing keys.
 */
export function enforcePermissionGate(actions, grantedPermissions) {
  const granted =
    grantedPermissions instanceof Set
      ? grantedPermissions
      : new Set(Array.isArray(grantedPermissions) ? grantedPermissions : []);

  const missing = new Set();

  for (const action of actions) {
    // Untouched: already resolved as unavailable/completed by another stage.
    if (action.status !== 'planned') continue;

    const needed = action.requiredPermissions || [];
    const lacking = needed.filter((permission) => !granted.has(permission));

    if (lacking.length) {
      action.status = 'blocked_permission';
      action.missingPermissions = lacking;
      lacking.forEach((permission) => missing.add(permission));
    } else {
      action.status = 'allowed'; // still needs the confirm stage before 'ready'
    }
  }

  return { actions, missing: [...missing] };
}

/**
 * Speakable explanation of what is missing, split into what is needed and why.
 * One permission keeps its full "why"; several get a short list with no
 * reasons — a chain of three clauses read aloud is unusable in an earbud.
 * The rationale strings are written as "<need>, <why>", so a single split
 * gives both halves.
 */
function explainPermissions(missing, languageCode) {
  const lang = langOf(languageCode) === 'hi' ? 'hi' : 'en';
  if (!missing.length) return { need: '', why: '' };

  if (missing.length === 1) {
    const rationale = PERMISSION_RATIONALE[missing[0]]?.[lang] || missing[0];
    const comma = rationale.indexOf(',');
    return comma === -1
      ? { need: rationale, why: '' }
      : { need: rationale.slice(0, comma), why: rationale.slice(comma + 1).trim() };
  }

  const joiner = lang === 'hi' ? 'aur' : 'and';
  const names = `${missing.slice(0, -1).join(', ')} ${joiner} ${missing[missing.length - 1]}`;
  return {
    need: lang === 'hi' ? `${names} ki permission` : `${names} access`,
    why: '',
  };
}

/** Build the spoken permission request for the missing keys. */
function permissionReply(missing, languageCode) {
  const { need, why } = explainPermissions(missing, languageCode);
  return phrases(languageCode).permission(need, why);
}

// ==========================================================================
// STAGE (f) — RESPOND: server-executed intents
// ==========================================================================

/**
 * Actually perform the things this server is responsible for. These are the
 * only intents whose replies may state a completed result, because the work
 * genuinely happened in this process.
 */
async function executeServerAction(action, { userId, transcript, languageCode, contextUsed }) {
  const p = phrases(languageCode);
  const params = action.params || {};

  switch (action.intent) {
    case 'remember': {
      const text = params.text || transcript;
      const saved = await safely(
        'memories.add',
        () => store.memories?.add?.(userId, text, { source: 'voice' }),
        null,
      );
      action.status = saved ? 'completed' : 'failed';
      action.result = saved ? { saved: true } : { saved: false };
      return saved ? p.remembered : p.error;
    }

    case 'recall': {
      const query = params.query || transcript;
      const hits = await safely(
        'memories.search',
        () => store.memories?.search?.(userId, query, 3),
        [],
      );
      const texts = (Array.isArray(hits) ? hits : [])
        .map((hit) => String(hit?.text ?? hit ?? ''))
        .filter(Boolean);

      action.status = 'completed';
      action.result = { count: texts.length };
      if (!texts.length) return p.nothingRemembered;
      return `${p.recallIntro} ${texts.slice(0, 3).join('. ')}`;
    }

    case 'translate': {
      const text = params.text || transcript;
      const target = params.targetLanguage || (langOf(languageCode) === 'hi' ? 'English' : 'Hindi');
      if (typeof gemini.translateText !== 'function') {
        action.status = 'failed';
        return p.translateFailed;
      }
      try {
        const translated = await gemini.translateText(
          text,
          target,
          params.sourceLanguage || 'auto',
        );
        action.status = 'completed';
        action.result = { translated };
        return translated;
      } catch (err) {
        console.warn(`[orchestrator] translate failed: ${err?.message || err}`);
        action.status = 'failed';
        return p.translateFailed;
      }
    }

    case 'ask_question':
    case 'smalltalk': {
      action.status = 'completed';
      return null; // answered from replyDraft / askGemini by the caller
    }

    default:
      return null;
  }
}

/**
 * Acknowledgement text for a client-executed action.
 * PHRASING RULE: every one of these says ULTRON is *asking the phone* to do
 * something. None of them says it was done — only the phone knows that, and it
 * tells us through context.lastActionResult on a later turn.
 */
function acknowledgeClientAction(action, languageCode, contextUsed) {
  const hi = langOf(languageCode) === 'hi';
  const p = action.params || {};

  switch (action.intent) {
    case 'call_contact':
      return hi
        ? `Theek hai — ${p.contactName || 'unhe'} ko call lagane ke liye phone se keh raha hoon.`
        : `Okay — asking your phone to call ${p.contactName || 'them'}.`;
    case 'call_emergency':
      return hi
        ? 'Emergency call ke liye phone se keh raha hoon.'
        : 'Asking your phone to place the emergency call.';
    case 'answer_call':
      return hi ? 'Call uthane ke liye keh raha hoon.' : 'Asking your phone to answer.';
    case 'reject_call':
      return hi ? 'Call reject karne ke liye keh raha hoon.' : 'Asking your phone to decline it.';
    case 'end_call':
      return hi ? 'Call kaatne ke liye keh raha hoon.' : 'Asking your phone to hang up.';
    case 'read_notifications':
      return hi ? 'Notifications padhne ke liye keh raha hoon.' : 'Asking your phone for your notifications.';
    case 'reply_message':
      return hi ? 'Reply bhejne ke liye keh raha hoon.' : 'Asking your phone to send that reply.';
    case 'play_music':
      return hi
        ? `${p.query ? `${p.query} ` : ''}chalane ke liye keh raha hoon.`
        : `Asking your phone to play${p.query ? ` ${p.query}` : ''}.`;
    case 'pause_music':
      return hi ? 'Music rokne ke liye keh raha hoon.' : 'Asking your phone to pause.';
    case 'next_track':
      return hi ? 'Agla gaana lagane ke liye keh raha hoon.' : 'Asking your phone to skip ahead.';
    case 'previous_track':
      return hi ? 'Pichla gaana lagane ke liye keh raha hoon.' : 'Asking your phone to go back.';
    case 'set_volume':
      return hi ? 'Volume badalne ke liye keh raha hoon.' : 'Asking your phone to change the volume.';
    case 'set_noise_mode':
      return hi
        ? `Noise mode ${p.mode || 'change'} karne ke liye keh raha hoon.`
        : `Asking your earbuds to switch noise mode${p.mode ? ` to ${p.mode}` : ''}.`;
    case 'device_status':
      return hi ? 'Earbuds ka status maang raha hoon.' : 'Asking your earbuds for their status.';
    case 'battery_status':
      // If the client already told us the battery this turn, we can answer for
      // real — that number came from the device, not from us.
      if (contextUsed.battery !== null && contextUsed.battery !== undefined) {
        return hi
          ? `Earbuds ki battery ${contextUsed.battery} percent hai.`
          : `Your earbuds are at ${contextUsed.battery} percent.`;
      }
      return hi ? 'Battery check karne ke liye keh raha hoon.' : 'Asking your earbuds for the battery level.';
    case 'find_earbuds':
      return hi ? 'Earbuds par locate tone bajane ke liye keh raha hoon.' : 'Asking your earbuds to play a locate tone.';
    case 'set_language':
      return hi
        ? `Language ${p.language || 'badalne'} set karne ke liye keh raha hoon.`
        : `Asking the app to switch to ${p.language || 'that language'}.`;
    case 'navigate':
      return hi
        ? `${p.destination || 'wahan'} ke liye navigation shuru karne ko keh raha hoon.`
        : `Asking your phone to start navigation to ${p.destination || 'there'}.`;
    case 'safety_mode': {
      const on = p.enabled !== false;
      const base = hi
        ? `Safety Mode ${on ? 'on' : 'off'} karne ke liye keh raha hoon.`
        : `Asking the app to turn Safety Mode ${on ? 'on' : 'off'}.`;
      // Honesty: Safety Mode is a flag plus transparency. Sound classification
      // (horn/siren) is NOT built, and we say so when switching it on.
      return on ? `${base} ${phrases(languageCode).safetyNote}` : base;
    }
    default:
      return hi ? 'Theek hai.' : 'Okay.';
  }
}

// ==========================================================================
// MAIN ENTRY POINT
// ==========================================================================

/**
 * Run one full turn. NEVER throws: any unexpected failure comes back as a
 * TurnResult with `error` set and a safe, honest `reply`.
 */
export async function runTurn({
  userId,
  text,
  languageCode = 'hi-IN',
  context = {},
  confirm = null,
}) {
  const uid = userId || 'anonymous';
  const transcript = String(text ?? '').trim();
  const result = emptyResult(transcript);
  const p = phrases(languageCode);

  try {
    // ------------------------------------------------- STAGE (b): CONTEXT
    // Built before the empty-input guard, because a turn with no new utterance
    // can still carry the phone's report about the last action it ran.
    const contextUsed = await buildContext({
      userId: uid,
      text: transcript,
      languageCode,
      context,
    });
    result.contextUsed = contextUsed;

    // A device action the phone already ran and reported back on. This is the
    // ONLY path where a reply may state that something happened.
    if (contextUsed.lastActionResult?.status) {
      const report = describeReportedAction(contextUsed.lastActionResult, languageCode);
      if (report && !transcript) {
        result.reply = report;
        result.intent = contextUsed.lastActionResult.intent || 'unknown';
        return await finalise(uid, result, transcript);
      }
    }

    // ---------------------------------------------------------------- empty
    if (!transcript && confirm === null) {
      result.reply = p.emptyInput;
      result.followUp = 'awaiting_command';
      return await finalise(uid, result, transcript);
    }

    // ------------------------------------------------- STAGE (e): CONFIRM
    // Resolve an outstanding confirmation before doing anything else. The
    // client may answer with confirm:true/false, or the user may simply say
    // "haan"/"nahi", which is what actually happens with voice.
    const pending = peekPendingPlan(uid);
    let confirmed = confirm === true;
    let rejected = confirm === false;

    if (pending && confirm === null && transcript) {
      if (AFFIRMATIVE.test(transcript)) confirmed = true;
      else if (NEGATIVE.test(transcript)) rejected = true;
    }

    if (rejected) {
      clearPendingPlan(uid);
      result.reply = p.cancelled;
      result.intent = pending?.classification?.intent || 'unknown';
      result.confidence = pending?.classification?.confidence || 0;
      return await finalise(uid, result, transcript);
    }

    if (confirmed && pending) {
      // The user said yes to a plan we already built: re-run the permission
      // gate against THIS turn's permission state (it can have changed) and
      // emit the actions without asking anything again.
      clearPendingPlan(uid);
      return await finalise(
        uid,
        await emitConfirmedPlan({
          result,
          userId: uid,
          transcript: pending.transcript || transcript,
          languageCode,
          contextUsed,
          classification: pending.classification,
          plan: pending.plan,
          actions: pending.actions.map((action) => ({ ...action, status: 'planned' })),
        }),
        transcript,
      );
    }

    // ---------------------------------------------- STAGE (a): UNDERSTAND
    let classification = null;
    let usedFallback = false;

    if (contextUsed.offline) {
      // The client told us it has no connectivity — do not burn 10 seconds on
      // a request that cannot succeed.
      classification = matchIntentOffline(transcript);
      usedFallback = true;
      result.degraded = 'no_language_model';
    } else {
      try {
        classification = await understand({
          userId: uid,
          text: transcript,
          languageCode,
          contextUsed,
        });
      } catch (err) {
        // STAGE (g): Gemini unreachable -> rule-based local matching.
        console.warn(`[orchestrator] understand() failed: ${err?.message || err}`);
        classification = matchIntentOffline(transcript);
        usedFallback = true;
        result.degraded = 'no_language_model';
      }
    }

    result.fallback = usedFallback;
    result.intent = classification.intent;
    result.confidence = classification.confidence;

    // ------------------------------------- STAGE (g): clarification needed
    if (classification.clarificationNeeded && classification.clarificationQuestion) {
      result.reply = classification.clarificationQuestion;
      result.followUp = 'clarification';
      return await finalise(uid, result, transcript);
    }

    // --------------------------------- STAGE (g): did not understand at all
    if (classification.intent === 'unknown') {
      // Never a bare "I don't understand" — always hand back a concrete example.
      result.reply = usedFallback ? `${p.noModel} ${p.unknown}` : p.unknown;
      result.followUp = 'retry_command';
      return await finalise(uid, result, transcript);
    }

    // ------------------------------- STAGE (g): contact resolution problems
    const contactIssue = checkContactResolution(classification, contextUsed, languageCode);
    if (contactIssue) {
      result.reply = contactIssue.reply;
      result.followUp = contactIssue.followUp;
      return await finalise(uid, result, transcript);
    }

    // ---------------------------------------------------- STAGE (c): PLAN
    const { plan, actions } = buildPlan(classification);
    result.plan = plan;
    result.actions = actions;

    // ------------------------------------- planned-but-unbuilt capabilities
    const unavailable = actions.filter((action) => action.status === 'unavailable');
    if (unavailable.length && unavailable.length === actions.length) {
      result.reply = p.plannedFeature;
      result.followUp = null;
      return await finalise(uid, result, transcript);
    }

    // ---------------------------------------- STAGE (d): PERMISSION GATE
    const gate = enforcePermissionGate(actions, contextUsed.grantedPermissions);
    result.needsPermission = gate.missing;

    if (gate.missing.length) {
      const blockedAll = actions.every((action) => action.status !== 'allowed');
      result.reply = permissionReply(gate.missing, languageCode);
      result.followUp = 'request_permission';

      if (blockedAll) {
        // Nothing is runnable: return the blocked actions for transparency, but
        // none of them are emitted as ready.
        return await finalise(uid, result, transcript);
      }
      // Partially blocked: the allowed steps continue below and the reply
      // already explains what was skipped and why.
    }

    // -------------------------------------------------- STAGE (e): CONFIRM
    const needsConfirm = actions.some(
      (action) => action.status === 'allowed' && action.requiresConfirmation,
    );

    if (needsConfirm && !confirmed) {
      actions.forEach((action) => {
        if (action.status === 'allowed') action.status = 'pending_confirmation';
      });

      rememberPendingPlan(uid, {
        transcript,
        classification,
        plan,
        actions: actions.map((action) => ({ ...action })),
      });

      result.needsConfirmation = true;
      result.reply = buildConfirmationQuestion(actions, languageCode);
      result.followUp = 'awaiting_confirmation';
      // Emergency gets a machine-readable cancel window as well as the spoken
      // one, so the client runs a countdown instead of a conversation.
      const emergency = actions.find((action) => action.intent === 'call_emergency');
      if (emergency) result.cancelWindowMs = EMERGENCY_CONFIRM_WINDOW_MS;

      return await finalise(uid, result, transcript);
    }

    // -------------------------------------------------- STAGE (f): RESPOND
    return await finalise(
      uid,
      await emitConfirmedPlan({
        result,
        userId: uid,
        transcript,
        languageCode,
        contextUsed,
        classification,
        plan,
        actions,
      }),
      transcript,
    );
  } catch (err) {
    // ------------------------------------------- STAGE (g): total failure
    // Honest and safe: we do not claim anything happened, and we say what to do.
    console.error(`[orchestrator] runTurn crashed: ${err?.stack || err}`);
    result.error = String(err?.message || err);
    result.fallback = true;
    result.reply = result.reply || p.error;
    result.needsConfirmation = false;
    // No conversation append here — the store may well be what broke.
    return result;
  }
}

/**
 * Emit an approved plan: run server-side work for real, acknowledge client-side
 * work as a request, and mark runnable actions 'ready'.
 */
async function emitConfirmedPlan({
  result,
  userId,
  transcript,
  languageCode,
  contextUsed,
  classification,
  plan,
  actions,
}) {
  const p = phrases(languageCode);

  result.plan = plan;
  result.actions = actions;
  result.intent = classification.intent;
  result.confidence = classification.confidence;
  result.needsConfirmation = false;

  // Re-gate: permissions are re-checked on the confirmation turn because they
  // can be revoked between the question and the answer.
  const gate = enforcePermissionGate(actions, contextUsed.grantedPermissions);
  result.needsPermission = gate.missing;

  if (gate.missing.length && actions.every((action) => action.status !== 'allowed')) {
    result.reply = permissionReply(gate.missing, languageCode);
    result.followUp = 'request_permission';
    return result;
  }

  const spoken = [];

  for (const action of actions) {
    if (action.status !== 'allowed') continue;

    if (action.executedBy === 'server') {
      const line = await executeServerAction(action, {
        userId,
        transcript,
        languageCode,
        contextUsed,
      });
      if (line) spoken.push(line);
      if (action.status === 'allowed') action.status = 'completed';
      // A failed translate means the language model is unreachable — say so in
      // `degraded` so the client can show the offline badge.
      if (action.status === 'failed' && action.intent === 'translate') {
        result.degraded = result.degraded || 'no_language_model';
      }
    } else {
      // The phone will run it. Mark ready and acknowledge the REQUEST only.
      action.status = 'ready';
      spoken.push(acknowledgeClientAction(action, languageCode, contextUsed));
    }
  }

  // ask_question / smalltalk: prefer the model's own draft; otherwise ask
  // Gemini directly; if that is down too, fall back honestly.
  const conversational = actions.find(
    (action) =>
      (action.intent === 'ask_question' || action.intent === 'smalltalk') &&
      action.status !== 'blocked_permission',
  );

  if (conversational && !spoken.length) {
    if (classification.replyDraft) {
      spoken.push(classification.replyDraft);
    } else if (typeof gemini.askGemini === 'function') {
      const answer = await safely(
        'askGemini',
        () => gemini.askGemini(userId, transcript, { languageCode }),
        null,
      );
      if (answer) {
        spoken.push(answer);
      } else {
        spoken.push(p.noModel);
        result.degraded = result.degraded || 'no_language_model';
      }
    } else {
      spoken.push(p.noModel);
      result.degraded = result.degraded || 'no_language_model';
    }
  }

  if (gate.missing.length) {
    // Partially blocked plan: say what went ahead AND what is still missing.
    spoken.push(permissionReply(gate.missing, languageCode));
    result.followUp = 'request_permission';
  }

  result.reply = spoken.filter(Boolean).join(' ').trim() || classification.replyDraft || p.error;
  return result;
}

/** Short, speakable confirmation question for the first confirmable action. */
function buildConfirmationQuestion(actions, languageCode) {
  const p = phrases(languageCode);
  const target = actions.find(
    (action) => action.status === 'pending_confirmation' && action.requiresConfirmation,
  );
  if (!target) return p.confirmGeneric('Ye');

  if (target.intent === 'call_emergency') {
    // FAST path by design: a statement plus a cancel word, not a question.
    return p.confirmEmergency(target.params?.contactName || (langOf(languageCode) === 'hi' ? 'emergency contact' : 'your emergency contact'));
  }

  if (target.intent === 'call_contact') {
    return p.confirmCall(target.params?.contactName || (langOf(languageCode) === 'hi' ? 'unhe' : 'them'));
  }

  if (target.intent === 'reply_message') {
    const hi = langOf(languageCode) === 'hi';
    const msg = target.params?.message;
    if (msg) {
      return hi ? `Bhejun: "${msg}"?` : `Send: "${msg}"?`;
    }
    return hi ? 'Reply bhejun?' : 'Send that reply?';
  }

  if (target.intent === 'navigate') {
    const hi = langOf(languageCode) === 'hi';
    const dest = target.params?.destination || (hi ? 'wahan' : 'there');
    return hi ? `${dest} ke liye navigation shuru karun?` : `Start navigation to ${dest}?`;
  }

  const entry = getIntent(target.intent);
  return p.confirmGeneric(entry?.description || target.intent);
}

/**
 * STAGE (g): contact problems. We never search contacts ourselves — the CLIENT
 * resolves names and tells us when it failed, including any near matches. We
 * echo exactly those back and ask, instead of guessing at a wrong call.
 */
function checkContactResolution(classification, contextUsed, languageCode) {
  const callIntents = ['call_contact', 'reply_message'];
  if (!callIntents.includes(classification.intent)) return null;

  const p = phrases(languageCode);
  const wanted = classification.params?.contactName;
  const resolution = contextUsed.contactResolution;

  if (!wanted && classification.intent === 'call_contact' && !classification.params?.contactId) {
    return { reply: p.whoToCall, followUp: 'need_contact_name' };
  }

  if (resolution && resolution.status !== 'ok') {
    if (resolution.candidates.length) {
      return {
        reply: p.contactChoose(resolution.candidates.join(', ')),
        followUp: 'disambiguate_contact',
      };
    }
    if (resolution.status === 'not_found') {
      return {
        reply: p.contactNotFound(resolution.query || wanted || ''),
        followUp: 'need_contact_name',
      };
    }
  }

  return null;
}

/**
 * Short spoken labels for reporting an outcome. Registry descriptions are
 * written for the classifier prompt and are far too long to say out loud.
 */
const ACTION_LABELS = {
  call_contact: { hi: 'Call', en: 'The call' },
  call_emergency: { hi: 'Emergency call', en: 'The emergency call' },
  answer_call: { hi: 'Call uthana', en: 'Answering' },
  reject_call: { hi: 'Call reject', en: 'Declining the call' },
  end_call: { hi: 'Call end', en: 'Hanging up' },
  read_notifications: { hi: 'Notifications', en: 'Reading notifications' },
  reply_message: { hi: 'Reply', en: 'The reply' },
  play_music: { hi: 'Gaana', en: 'Playback' },
  pause_music: { hi: 'Pause', en: 'Pausing' },
  next_track: { hi: 'Gaana badalna', en: 'Skipping ahead' },
  previous_track: { hi: 'Gaana badalna', en: 'Going back' },
  set_volume: { hi: 'Volume change', en: 'The volume change' },
  set_noise_mode: { hi: 'Noise mode change', en: 'The noise mode change' },
  device_status: { hi: 'Status check', en: 'The status check' },
  battery_status: { hi: 'Battery check', en: 'The battery check' },
  find_earbuds: { hi: 'Earbuds locate', en: 'The locate tone' },
  set_language: { hi: 'Language change', en: 'The language change' },
  navigate: { hi: 'Navigation', en: 'Navigation' },
  safety_mode: { hi: 'Safety Mode', en: 'Safety Mode' },
};

/**
 * Turn a CLIENT-REPORTED action outcome into speech. This is the one place a
 * reply may state that something actually happened, because the phone said so.
 */
function describeReportedAction(report, languageCode) {
  const p = phrases(languageCode);
  const hi = langOf(languageCode) === 'hi';
  const label =
    ACTION_LABELS[report.intent]?.[hi ? 'hi' : 'en'] || (hi ? 'Kaam' : 'That');
  if (report.status === 'success') return p.actionDone(label);
  if (report.status === 'failed') {
    return report.message ? `${p.actionFailed(label)} ${report.message}` : p.actionFailed(label);
  }
  return null;
}

/**
 * Persist the turn and hand the result back. Conversation memory is what makes
 * "usko call karo" work on the next turn, so it is appended for every completed
 * turn — but a store failure must never break the reply the user is waiting on.
 */
async function finalise(userId, result, transcript) {
  const turnAt = new Date().toISOString();

  if (transcript) {
    await safely('conversations.append(user)', () =>
      store.conversations?.append?.(userId, {
        role: 'user',
        text: transcript,
        at: turnAt,
      }),
    );
  }

  if (result.reply) {
    await safely('conversations.append(assistant)', () =>
      store.conversations?.append?.(userId, {
        role: 'assistant',
        text: result.reply,
        intent: result.intent,
        at: turnAt,
      }),
    );
  }

  return result;
}
