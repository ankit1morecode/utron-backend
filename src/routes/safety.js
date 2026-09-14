/**
 * ULTRON AIR — Safety Layer API.
 *
 * ==================== READ THIS BEFORE DESCRIBING THIS FILE ====================
 * ENVIRONMENTAL SOUND CLASSIFICATION IS NOT IMPLEMENTED. It is a PLANNED capability.
 *
 * Nothing here detects a horn, a siren, a shout, or a crash. There is no audio model
 * in this backend and no audio ever reaches it. POST /:userId/events currently accepts
 * only what the PHONE reports — in practice a device-metering loud-event report (a
 * microphone amplitude / dBFS threshold crossing), optionally carrying the client's own
 * guess at what the sound was. Every event is therefore stored and returned as an
 * UNVALIDATED CLAIM (`validated: false`, `classification: "client-reported"`), and
 * store.js additionally downgrades a specific kind (horn/siren/alarm/shout) to
 * `loud_unknown` unless a real classifier is named as the detector.
 *
 * Consequently NOTHING in this file may be presented — in a demo, a pitch, a README or
 * UI copy — as validated hazard detection, danger awareness, or accident detection.
 * The accurate description is: "the phone reports loud-sound events; the backend
 * records, debounces and exposes them, and can resolve an emergency contact for the
 * phone to call."
 *
 * `safetyMode.enabled` likewise records a user PREFERENCE for a planned capability.
 * Storing it true does not mean anything is listening.
 *
 * SERVER PLANS, PHONE EXECUTES. This server never places a call, never sends an SMS and
 * never shares a location with anyone. /emergency returns an INSTRUCTION for the client
 * to carry out; its spoken text is written in the future tense for exactly that reason,
 * and no response here ever states that a call was made.
 * ==============================================================================
 */

import { Router } from "express";
import { safety } from "../services/store.js";
import { textToSpeech, isSarvamConfigured } from "../services/sarvam.js";
import { asyncHandler } from "../middleware/index.js";

const router = Router();

const wrap =
  typeof asyncHandler === "function"
    ? asyncHandler
    : (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ *
 * Profile validation
 * ------------------------------------------------------------------ *
 * Shapes mirror models/SafetyProfile.js exactly: safetyMode and drivingMode are
 * SUBDOCUMENTS, not booleans, and an emergency contact's primary flag is `isPrimary`.
 * Writing a boolean over a subdocument would fail mongoose validation while still
 * landing in store.js's Map fallback — i.e. the database and the fallback would
 * disagree about a safety setting. Hence a strict, shape-aware whitelist.
 */

const MAX_EMERGENCY_CONTACTS = 10;
const MAX_TRUSTED_CONTACTS = 20;
const SENSITIVITIES = ["low", "medium", "high"];

const SAFETY_MODE_BOOLS = [
  "enabled",
  "autoVolumeReduction",
  "spokenWarnings",
  "shareLocationOnEmergency",
];
const DRIVING_MODE_BOOLS = [
  "enabled",
  "autoDetect",
  "announceCallers",
  "announceImportantOnly",
];

const PROFILE_FIELDS = ["emergencyContacts", "trustedContacts", "safetyMode", "drivingMode"];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Accept `true` / `"on"` / `"off"` from an older app build and widen it to the real
 * subdocument ({ enabled }) instead of clobbering the whole branch with a scalar.
 */
function coerceModeScalar(value) {
  if (typeof value === "boolean") return { enabled: value };
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "on" || v === "true") return { enabled: true };
    if (v === "off" || v === "false") return { enabled: false };
  }
  return undefined;
}

function cleanModeObject(raw, field, boolKeys, allowSensitivity, errors, unknown) {
  let obj = raw;
  if (!isPlainObject(obj)) {
    obj = coerceModeScalar(raw);
    if (!isPlainObject(obj)) {
      errors.push(
        `${field} must be an object (e.g. { "enabled": true }) or a boolean`
      );
      return undefined;
    }
  }

  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "sensitivity" && allowSensitivity) {
      if (typeof value !== "string" || !SENSITIVITIES.includes(value)) {
        errors.push(`${field}.sensitivity must be one of: ${SENSITIVITIES.join(", ")}`);
      } else {
        out.sensitivity = value;
      }
      continue;
    }
    if (!boolKeys.includes(key)) {
      unknown.push(`${field}.${key}`);
      continue;
    }
    if (typeof value !== "boolean") {
      errors.push(`${field}.${key} must be a boolean`);
      continue;
    }
    out[key] = value;
  }

  if (Object.keys(out).length === 0 && !errors.length && !unknown.length) {
    errors.push(`${field} contained no recognised settings`);
    return undefined;
  }
  return out;
}

// Loose on formatting (people store "+91 98765 43210", "011-2345 6789", "112"),
// strict on substance: it must be dialable digits, not a name or a note. A contact
// whose phone is junk is worse than no contact at all — it fails at the worst moment.
function normalizePhone(raw, label, errors) {
  if (typeof raw !== "string" || !raw.trim()) {
    errors.push(`${label}: phone is required and must be a non-empty string`);
    return null;
  }
  const phone = raw.trim();
  if (phone.length > 24) {
    errors.push(`${label}: phone is too long`);
    return null;
  }
  if (/[A-Za-z]/.test(phone)) {
    errors.push(`${label}: phone must not contain letters`);
    return null;
  }
  if (!/^[+()\-.\s\d]+$/.test(phone)) {
    errors.push(`${label}: phone contains unsupported characters`);
    return null;
  }
  const digits = phone.replace(/\D/g, "");
  // 3 digits covers short emergency numbers (112, 100); 15 is the E.164 maximum.
  if (digits.length < 3 || digits.length > 15) {
    errors.push(`${label}: phone must contain between 3 and 15 digits`);
    return null;
  }
  return phone;
}

function normalizeContact(raw, label, allowPrimary, errors, unknown) {
  if (!isPlainObject(raw)) {
    errors.push(`${label}: each contact must be an object with name and phone`);
    return null;
  }

  const known = new Set(["name", "phone", "relation"]);
  if (allowPrimary) {
    known.add("isPrimary");
    known.add("primary"); // alias from the app; canonicalised to isPrimary below
  }
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) unknown.push(`${label}.${key}`);
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    errors.push(`${label}: name is required`);
    return null;
  }
  if (name.length > 80) {
    errors.push(`${label}: name must be at most 80 characters`);
    return null;
  }

  const phone = normalizePhone(raw.phone, label, errors);
  if (!phone) return null;

  const contact = { name, phone, relation: "" };

  if (raw.relation !== undefined && raw.relation !== null) {
    if (typeof raw.relation !== "string" || raw.relation.trim().length > 40) {
      errors.push(`${label}: relation must be a string of at most 40 characters`);
    } else {
      contact.relation = raw.relation.trim();
    }
  }

  if (allowPrimary) {
    const flag = raw.isPrimary ?? raw.primary;
    if (flag !== undefined && flag !== null) {
      if (typeof flag !== "boolean") errors.push(`${label}: isPrimary must be a boolean`);
      else contact.isPrimary = flag;
    }
  }

  return contact;
}

function normalizeContactList(raw, field, max, allowPrimary, errors, unknown) {
  if (!Array.isArray(raw)) {
    errors.push(`${field} must be an array of { name, phone } objects`);
    return null;
  }
  if (raw.length > max) {
    errors.push(`${field} may contain at most ${max} contacts`);
    return null;
  }

  const before = errors.length;
  const list = [];
  raw.forEach((item, i) => {
    const contact = normalizeContact(item, `${field}[${i}]`, allowPrimary, errors, unknown);
    if (contact) list.push(contact);
  });

  // Contact arrays replace wholesale in store.js, so a partially-valid list must never
  // be written — silently dropping one emergency contact is a safety bug.
  if (errors.length > before) return null;

  // Make "primary" deterministic at write time so /emergency never has to guess:
  // first flagged wins; if none is flagged, the first contact becomes primary.
  if (allowPrimary && list.length) {
    let seen = false;
    for (const c of list) {
      if (c.isPrimary && !seen) seen = true;
      else c.isPrimary = false;
    }
    if (!seen) list[0].isPrimary = true;
  }

  return list;
}

function buildProfilePatch(bodyIn) {
  const patch = {};
  const unknown = [];
  const errors = [];

  for (const [key, value] of Object.entries(bodyIn || {})) {
    if (!PROFILE_FIELDS.includes(key)) {
      unknown.push(key);
      continue;
    }
    if (value === undefined) continue;

    if (key === "emergencyContacts") {
      const list = normalizeContactList(
        value,
        key,
        MAX_EMERGENCY_CONTACTS,
        true,
        errors,
        unknown
      );
      if (list) patch[key] = list;
    } else if (key === "trustedContacts") {
      const list = normalizeContactList(
        value,
        key,
        MAX_TRUSTED_CONTACTS,
        false,
        errors,
        unknown
      );
      if (list) patch[key] = list;
    } else if (key === "safetyMode") {
      const mode = cleanModeObject(value, key, SAFETY_MODE_BOOLS, true, errors, unknown);
      if (mode) patch[key] = mode;
    } else {
      const mode = cleanModeObject(value, key, DRIVING_MODE_BOOLS, false, errors, unknown);
      if (mode) patch[key] = mode;
    }
  }

  return { patch, unknown, errors };
}

// Read-side normalisation only — fills gaps so the app always gets a consistent shape.
// It does not write, so it never fabricates settings the user did not save.
function shapeProfile(profile, userId) {
  const p = isPlainObject(profile) ? profile : {};
  const mode = isPlainObject(p.safetyMode) ? p.safetyMode : {};
  const driving = isPlainObject(p.drivingMode) ? p.drivingMode : {};
  return {
    ...p,
    userId: p.userId || userId,
    emergencyContacts: Array.isArray(p.emergencyContacts) ? p.emergencyContacts : [],
    trustedContacts: Array.isArray(p.trustedContacts) ? p.trustedContacts : [],
    safetyMode: {
      enabled: false,
      sensitivity: "medium",
      autoVolumeReduction: true,
      spokenWarnings: true,
      shareLocationOnEmergency: false,
      ...mode,
    },
    drivingMode: {
      enabled: false,
      autoDetect: false,
      announceCallers: true,
      announceImportantOnly: true,
      ...driving,
    },
  };
}

function resolvePrimaryContact(profile) {
  const list = Array.isArray(profile?.emergencyContacts) ? profile.emergencyContacts : [];
  if (!list.length) return null;
  return list.find((c) => c && (c.isPrimary || c.primary)) || list[0];
}

/* ------------------------------------------------------------------ *
 * Event vocabulary — kept identical to services/store.js
 * ------------------------------------------------------------------ *
 * Mismatched vocabularies are silent data loss: store.js normalises an unknown kind to
 * `loud_unknown` and an unknown action to `none`, so a route that happily accepted
 * "glass_break" would 200 while persisting something else entirely. Validate against
 * the same lists, and translate legacy spellings explicitly.
 */
const EVENT_KINDS = [
  "horn",
  "siren",
  "alarm",
  "shout",
  "loud_unknown",
  "manual_trigger",
  "emergency_call",
];
const EVENT_ACTIONS = ["none", "volume_reduced", "warned", "call_placed"];
const EVENT_DETECTORS = ["device_metering", "manual", "planned_classifier"];

const KIND_ALIASES = {
  "loud-sound": "loud_unknown",
  loud_sound: "loud_unknown",
  loud: "loud_unknown",
  noise: "loud_unknown",
  unknown: "loud_unknown",
  impact: "loud_unknown",
  glass_break: "loud_unknown",
  emergency_trigger: "manual_trigger",
  "manual-trigger": "manual_trigger",
};
const DETECTOR_ALIASES = {
  "device-metering": "device_metering",
  metering: "device_metering",
  device: "device_metering",
  user: "manual",
};

/**
 * Mirrors store.js normaliseEvent(): raw loudness metering cannot identify a sound, so
 * a named kind only survives when a real classifier is the detector. Duplicated here
 * (not imported — store.js does not export it) so debouncing keys on the kind that will
 * actually be stored, and so the response can tell the client it was downgraded.
 */
function effectiveKind(kind, detectedBy) {
  const classified = ["horn", "siren", "alarm", "shout"].includes(kind);
  return classified && detectedBy !== "planned_classifier" ? "loud_unknown" : kind;
}

/* ------------------------------------------------------------------ *
 * Event debouncing
 * ------------------------------------------------------------------ *
 * The spec explicitly requires not nagging the user with repeated warnings from false
 * detections. One lorry horn produces a burst of threshold crossings, so the same kind
 * of event inside the cooldown window is COLLAPSED into the last accepted event rather
 * than stored and re-announced. Collapsing (not dropping) keeps the count, so
 * "17 suppressed in 20s" stays visible for threshold tuning.
 */
const DEFAULT_COOLDOWN_MS = (() => {
  const fromEnv = Number.parseInt(process.env.SAFETY_EVENT_COOLDOWN_MS || "", 10);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 20_000;
})();
const MAX_COOLDOWN_MS = 300_000;

const recentEvents = new Map(); // `${userId}::${kind}` -> { at, event, suppressedCount }
const MAX_DEBOUNCE_KEYS = 2000;

function rememberEvent(key, event) {
  if (!recentEvents.has(key) && recentEvents.size >= MAX_DEBOUNCE_KEYS) {
    recentEvents.delete(recentEvents.keys().next().value);
  }
  recentEvents.delete(key);
  recentEvents.set(key, { at: Date.now(), event, suppressedCount: 0 });
}

function normalizeLocation(raw, errors) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    errors.push("location must be an object like { lat, lng, accuracy? }");
    return null;
  }
  const lat = Number(raw.lat ?? raw.latitude);
  const lng = Number(raw.lng ?? raw.longitude ?? raw.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    errors.push("location.lat must be a number between -90 and 90");
    return null;
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    errors.push("location.lng must be a number between -180 and 180");
    return null;
  }
  const loc = { lat, lng };
  const acc = Number(raw.accuracy);
  if (Number.isFinite(acc) && acc >= 0) loc.accuracy = acc;
  return loc;
}

/* ------------------------------------------------------------------ *
 * Speech helper — spoken prompts are best-effort, never fatal
 * ------------------------------------------------------------------ */
async function speak(text, languageCode) {
  if (!text) return { audio: null, degraded: null };
  if (!isSarvamConfigured()) return { audio: null, degraded: "tts-not-configured" };
  try {
    const audio = await textToSpeech(text, languageCode);
    return { audio: audio || null, degraded: audio ? null : "tts-empty-response" };
  } catch (err) {
    console.error("[safety] TTS failed:", err.message);
    return { audio: null, degraded: "tts-unavailable" };
  }
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

// GET /api/safety/:userId/profile
router.get(
  "/:userId/profile",
  wrap(async (req, res) => {
    const { userId } = req.params;
    try {
      const profile = await safety.getProfile(userId);
      res.json({ profile: shapeProfile(profile, userId) });
    } catch (err) {
      console.error("[safety] getProfile failed:", err.message);
      // Degrade to defaults, clearly flagged — an empty contact list must never be
      // mistaken for a configured one on a safety screen.
      res.json({
        profile: shapeProfile(null, userId),
        degraded: "safety-store-unavailable",
        error: "Safety settings could not be read. Shown values are defaults, not yours.",
      });
    }
  })
);

// PATCH /api/safety/:userId/profile — whitelisted safety settings only.
router.patch(
  "/:userId/profile",
  wrap(async (req, res) => {
    const { userId } = req.params;

    if (!isPlainObject(req.body)) {
      return res.status(400).json({ error: "Request body must be a JSON object" });
    }

    const { patch, unknown, errors } = buildProfilePatch(req.body);

    if (unknown.length) {
      return res.status(400).json({
        error: `Unknown safety profile field(s): ${unknown.join(", ")}`,
        unknownFields: unknown,
        allowedFields: PROFILE_FIELDS,
      });
    }
    if (errors.length) {
      return res
        .status(400)
        .json({ error: errors[0], details: errors, allowedFields: PROFILE_FIELDS });
    }
    if (Object.keys(patch).length === 0) {
      return res
        .status(400)
        .json({ error: "No patchable fields supplied", allowedFields: PROFILE_FIELDS });
    }

    try {
      const profile = await safety.patchProfile(userId, patch);
      res.json({
        profile: shapeProfile(profile, userId),
        updatedFields: Object.keys(patch),
        ...(patch.safetyMode?.enabled
          ? {
              // Do not let a settings screen turn a stored preference into a claim.
              note: "Safety Mode preference saved. Sound classification is a planned capability — nothing is listening for horns or sirens yet.",
            }
          : {}),
      });
    } catch (err) {
      console.error("[safety] patchProfile failed:", err.message);
      res.status(503).json({
        saved: false,
        error: "Safety settings could not be saved. Please retry before relying on them.",
        degraded: "safety-store-unavailable",
        detail: err.message,
      });
    }
  })
);

// POST /api/safety/:userId/events
// { kind, confidence?, level?, action?, detectedBy?, location?, cooldownMs? }
//
// The phone reporting a LOUD EVENT it metered. The backend classifies nothing (see the
// file header): `kind` is the client's own label, stored as an unvalidated claim, and
// `action` records only what the CLIENT says it already did.
router.post(
  "/:userId/events",
  wrap(async (req, res) => {
    const { userId } = req.params;
    const b = isPlainObject(req.body) ? req.body : {};
    const errors = [];

    let detectedBy = "device_metering";
    if (b.detectedBy !== undefined && b.detectedBy !== null) {
      const d = String(b.detectedBy).trim().toLowerCase();
      const mapped = DETECTOR_ALIASES[d] || d;
      if (!EVENT_DETECTORS.includes(mapped)) {
        errors.push(`detectedBy must be one of: ${EVENT_DETECTORS.join(", ")}`);
      } else {
        detectedBy = mapped;
      }
    }

    let kind = "";
    const rawKind = typeof b.kind === "string" ? b.kind.trim().toLowerCase() : "";
    if (!rawKind) {
      errors.push("kind is required");
    } else {
      kind = KIND_ALIASES[rawKind] || rawKind;
      if (!EVENT_KINDS.includes(kind)) {
        errors.push(`kind must be one of: ${EVENT_KINDS.join(", ")}`);
      }
    }

    let confidence = null;
    if (b.confidence !== undefined && b.confidence !== null) {
      const c = Number(b.confidence);
      if (!Number.isFinite(c) || c < 0 || c > 1) errors.push("confidence must be between 0 and 1");
      else confidence = c;
    }

    let level = null;
    if (b.level !== undefined && b.level !== null) {
      const l = Number(b.level);
      // Handset metering reports dBFS (negative) or dB SPL (positive); allow both.
      if (!Number.isFinite(l) || l < -200 || l > 200) errors.push("level must be a number in dB");
      else level = l;
    }

    let action = "none";
    if (b.action !== undefined && b.action !== null) {
      if (!EVENT_ACTIONS.includes(b.action)) {
        errors.push(`action must be one of: ${EVENT_ACTIONS.join(", ")}`);
      } else {
        action = b.action;
      }
    }

    const location = normalizeLocation(b.location, errors);

    let cooldownMs = DEFAULT_COOLDOWN_MS;
    if (b.cooldownMs !== undefined && b.cooldownMs !== null) {
      const c = Number(b.cooldownMs);
      if (!Number.isFinite(c) || c < 0 || c > MAX_COOLDOWN_MS) {
        errors.push(`cooldownMs must be between 0 and ${MAX_COOLDOWN_MS}`);
      } else {
        cooldownMs = c;
      }
    }

    if (errors.length) {
      return res.status(400).json({ error: errors[0], details: errors });
    }

    // Debounce on the kind that will actually be STORED, so a burst reported first as
    // "horn" and then as "loud_sound" still collapses into one warning.
    const storedKind = effectiveKind(kind, detectedBy);
    const key = `${userId}::${storedKind}`;
    const previous = recentEvents.get(key);
    const now = Date.now();

    if (previous && cooldownMs > 0 && now - previous.at < cooldownMs) {
      previous.suppressedCount += 1;
      return res.json({
        event: previous.event, // the last ACCEPTED event this one collapsed into
        suppressed: true,
        suppressedCount: previous.suppressedCount,
        cooldownMs,
        retryInMs: cooldownMs - (now - previous.at),
        note: "Same event kind within the cooldown window — collapsed, not stored. Do not warn the user again.",
      });
    }

    const payload = {
      kind,
      confidence: confidence ?? 0,
      level,
      action,
      detectedBy,
      location,
      at: new Date(now).toISOString(),
    };

    // Honesty flags are attached to the RESPONSE, not to the payload: store.js persists
    // a deliberately whitelisted event shape, so claiming they were saved would be a
    // second-order lie. They are constants here because nothing in this backend can
    // validate an event — if that ever changes, they must be computed, not hardcoded.
    const honesty = {
      validated: false,
      classification: "client-reported",
      reportedKind: rawKind,
      downgraded: storedKind !== kind,
      ...(storedKind !== kind
        ? {
            downgradeReason:
              "Loudness metering cannot identify a sound; the specific kind was not kept.",
          }
        : {}),
    };

    try {
      const saved = await safety.addEvent(userId, payload);
      const stored = saved || payload;
      rememberEvent(key, { ...stored, ...honesty });
      res.json({ event: { ...stored, ...honesty }, suppressed: false, cooldownMs });
    } catch (err) {
      console.error("[safety] addEvent failed:", err.message);
      // Still debounce in memory: a failing store must not become a warning storm.
      const event = { ...payload, kind: storedKind, ...honesty };
      rememberEvent(key, event);
      res.json({
        event,
        suppressed: false,
        persisted: false, // never claim a durable write that did not happen
        cooldownMs,
        degraded: "safety-store-unavailable",
        error: "Event accepted in memory but not persisted.",
      });
    }
  })
);

// GET /api/safety/:userId/events?limit=
router.get(
  "/:userId/events",
  wrap(async (req, res) => {
    const parsed = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;

    try {
      const events = await safety.listEvents(req.params.userId, limit);
      res.json({
        events: events || [],
        count: (events || []).length,
        limit,
        note: "All events are client-reported loud-sound reports. This backend performs no audio classification.",
      });
    } catch (err) {
      console.error("[safety] listEvents failed:", err.message);
      res.json({
        events: [],
        count: 0,
        limit,
        degraded: "safety-store-unavailable",
        error: "Safety events could not be read right now.",
      });
    }
  })
);

// POST /api/safety/:userId/emergency
// { trigger: 'voice'|'manual', confirm?, location?, languageCode?, speak? }
//
// THE SERVER NEVER PLACES THE CALL. It resolves which number should be dialled and
// returns an instruction; the phone holds the telephony permission, performs the dial,
// and reports the outcome back (as an event with action: 'call_placed'). No response
// below states that a call happened.
router.post(
  "/:userId/emergency",
  wrap(async (req, res) => {
    const { userId } = req.params;
    const b = isPlainObject(req.body) ? req.body : {};
    const errors = [];

    const trigger = typeof b.trigger === "string" ? b.trigger.trim().toLowerCase() : "manual";
    if (!["voice", "manual"].includes(trigger)) errors.push('trigger must be "voice" or "manual"');
    if (b.confirm !== undefined && b.confirm !== null && typeof b.confirm !== "boolean") {
      errors.push("confirm must be a boolean");
    }
    const location = normalizeLocation(b.location, errors);
    const languageCode = typeof b.languageCode === "string" ? b.languageCode : "hi-IN";
    const shouldSpeak = b.speak !== false;

    if (errors.length) {
      return res.status(400).json({ error: errors[0], details: errors });
    }

    const english = languageCode.toLowerCase().startsWith("en");

    let profile = null;
    let degraded = null;
    try {
      profile = await safety.getProfile(userId);
    } catch (err) {
      console.error("[safety] getProfile failed during emergency:", err.message);
      degraded = "safety-store-unavailable";
    }

    const shaped = shapeProfile(profile, userId);
    const contact = resolvePrimaryContact(shaped);

    /* --- no contact configured: an actionable answer, not an error ------------- */
    if (!contact) {
      const spokenPrompt = english
        ? "No emergency contact is saved yet. Open ULTRON, go to Safety and add one — then I can dial it for you in one tap. For immediate help, dial 112 from your phone."
        : "Abhi koi emergency contact save nahi hai. ULTRON app kholiye, Safety me jaakar ek contact add kijiye — phir main ek tap me call ka instruction bhej paunga. Turant madad ke liye phone se 112 dial kijiye.";

      const spoken = shouldSpeak
        ? await speak(spokenPrompt, languageCode)
        : { audio: null, degraded: null };

      return res.json({
        contact: null,
        action: "configure_emergency_contact",
        requiresConfirmation: false,
        spokenPrompt,
        audio: spoken.audio,
        setup: {
          endpoint: `PATCH /api/safety/${userId}/profile`,
          field: "emergencyContacts",
          example: {
            emergencyContacts: [
              { name: "Mom", phone: "+919876543210", relation: "mother", isPrimary: true },
            ],
          },
        },
        // A suggestion the USER can act on — not an action we claim to have planned.
        fallbackSuggestion: {
          label: "India-wide emergency number",
          number: "112",
          note: "The phone must dial this; the server cannot and will not place calls.",
        },
        degraded: degraded || spoken.degraded || null,
        error: degraded
          ? "Emergency contacts could not be read, so none could be resolved."
          : null,
      });
    }

    /* --- contact resolved: return an instruction for the client to execute ----- */
    const confirmed = b.confirm === true;
    const requiresConfirmation = !confirmed;

    const spokenPrompt = requiresConfirmation
      ? english
        ? `I can call ${contact.name} on ${contact.phone}. Say "yes" to confirm.`
        : `Main ${contact.name} ko call kar sakta hoon — number ${contact.phone}. Confirm karne ke liye "haan" boliye.`
      : english
        ? `Confirmed. Your phone will now dial ${contact.name}. If it does not connect, dial ${contact.phone} yourself.`
        : `Confirm ho gaya. Aapka phone ab ${contact.name} ko dial karega. Agar call na lage to khud ${contact.phone} dial kijiye.`;
    // ^ Future tense plus a manual fallback: this describes what the phone is being
    //   ASKED to do. It never asserts that a call connected.

    const spoken = shouldSpeak
      ? await speak(spokenPrompt, languageCode)
      : { audio: null, degraded: null };

    // Respect the user's location-sharing preference even though we only echo it back:
    // an emergency is not a licence to log coordinates the user opted out of storing.
    const shareLocation = shaped.safetyMode.shareLocationOnEmergency === true;
    const sharedLocation = shareLocation ? location : null;

    // Log the trigger. Deliberately bypasses the debounce map: an emergency trigger is
    // user-initiated, so suppressing a repeat would be the dangerous choice. `action`
    // stays 'none' — the call has not been placed by anyone yet.
    let logged = true;
    try {
      await safety.addEvent(userId, {
        kind: "manual_trigger",
        confidence: 1,
        action: "none",
        detectedBy: "manual", // user-initiated by voice or tap, never auto-detected
        location: sharedLocation,
        at: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[safety] emergency event log failed:", err.message);
      logged = false;
      degraded = degraded || "safety-store-unavailable";
    }

    res.json({
      contact,
      action: "call",
      intent: "call_emergency",
      params: { name: contact.name, phone: contact.phone },
      requiresConfirmation,
      confirmed,
      requiredPermissions: ["phone"],
      executedBy: "client", // the phone dials; the server only instructs
      status: requiresConfirmation ? "awaiting_confirmation" : "planned",
      trigger,
      location: sharedLocation,
      ...(location && !shareLocation
        ? { locationWithheld: "safetyMode.shareLocationOnEmergency is off" }
        : {}),
      spokenPrompt,
      audio: spoken.audio,
      eventLogged: logged,
      degraded: degraded || spoken.degraded || null,
      note: "The server has NOT placed a call. It returns the dial instruction; the client must execute it and report the outcome back as an event with action 'call_placed'.",
    });
  })
);

export default router;
