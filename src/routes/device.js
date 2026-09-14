/**
 * ULTRON AIR — device preferences + live earbud telemetry.
 *
 * Two very different kinds of data live here on purpose:
 *
 *   1. PREFERENCES (durable) — language, sound profile, noise control, wake word,
 *      notification rules, touch mappings, privacy/offline/accessibility toggles.
 *      Persisted through services/store.js (Mongo when available, in-process Map
 *      fallback otherwise). Routes never touch mongoose models directly.
 *
 *   2. STATE / TELEMETRY (ephemeral) — is the case open, what is the battery on the
 *      left bud, which firmware is flashed. This changes every few seconds, is only
 *      meaningful while the phone is connected, and is worthless after a restart, so
 *      it is kept in a bounded in-process Map instead of a collection.
 *
 * HONESTY RULE: the server never observes the earbuds. Every value under /state is
 * whatever the PHONE last reported, echoed back with a timestamp. If the phone has
 * not reported we say so (`reported: false`) rather than inventing `connected: false`,
 * and once a snapshot ages past STALE_AFTER_MS we mark it `stale: true` so the app
 * does not render a two-hour-old battery percentage as live. A successful PATCH means
 * "the preference was stored", never "the earbuds were reconfigured" — only the phone
 * can do that, and only it can report that it worked.
 */

import { Router } from "express";
import { users } from "../services/store.js";
import { INTENT_NAMES } from "../services/intents.js";
import { asyncHandler } from "../middleware/index.js";

const router = Router();

// Defensive: if the shared asyncHandler is ever swapped for something that is not a
// function, fall back to a local equivalent instead of crashing the router at boot.
const wrap =
  typeof asyncHandler === "function"
    ? asyncHandler
    : (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const intentNames = Array.isArray(INTENT_NAMES) ? INTENT_NAMES : null;

// Matches models/User.js and the set_noise_mode intent. Keep these three in sync with
// both — a fourth mode invented here would be stored and never honoured by anything.
const NOISE_MODES = ["off", "anc", "transparency"];

/* ------------------------------------------------------------------ *
 * Preference whitelist
 * ------------------------------------------------------------------ *
 * An un-whitelisted `$set` is how preference documents get silently corrupted: one
 * typo'd key from a stale app build ("noise_control", "wakeword") writes a junk field
 * that nothing reads and nothing cleans up — and because store.js falls back to a Map
 * when Mongo is down, a shape mongoose would have rejected can still land in memory
 * and diverge from the database. So: known keys only, NESTED keys included, and a 400
 * that NAMES the offending paths plus the allowed set.
 *
 * Shapes below mirror models/User.js exactly (wakeWord/voice are objects,
 * notificationRules/touchMappings are arrays). Getting this wrong would clobber a
 * subdocument with a scalar.
 */
const bools = (keys) =>
  Object.fromEntries(keys.map((k) => [k, { kind: "boolean" }]));

const FIELD_SPECS = {
  preferredLanguage: { kind: "langCode" },
  // models/User.js leaves soundProfile a free-form String, so stay permissive here:
  // the app ships independently and may add EQ presets before the backend hears of them.
  soundProfile: { kind: "string", max: 32 },
  noiseControl: { kind: "enum", values: NOISE_MODES },
  responseStyle: { kind: "enum", values: ["concise", "balanced", "detailed"] },

  wakeWord: {
    kind: "object",
    // Tolerate `wakeWord: "Ultron"` from an older build rather than overwriting the
    // whole subdocument with a string.
    coerceScalar: (v) => (typeof v === "string" ? { phrase: v } : undefined),
    shape: {
      phrase: { kind: "string", max: 40 },
      enabled: { kind: "boolean" },
      sensitivity: { kind: "enum", values: ["low", "medium", "high"] },
    },
  },
  voice: {
    kind: "object",
    coerceScalar: (v) => (typeof v === "string" ? { speaker: v } : undefined),
    shape: {
      speaker: { kind: "string", max: 40 },
      rate: { kind: "number", min: 0.3, max: 3 },
      pitch: { kind: "number", min: -10, max: 10 },
    },
  },

  notificationRules: {
    kind: "array",
    maxItems: 40,
    item: {
      kind: "object",
      shape: {
        category: { kind: "string", max: 40, required: true },
        read: { kind: "boolean" },
        importance: { kind: "enum", values: ["low", "normal", "high"] },
      },
    },
  },
  touchMappings: {
    kind: "array",
    maxItems: 12,
    item: {
      kind: "object",
      shape: {
        side: { kind: "enum", values: ["left", "right"] },
        gesture: { kind: "enum", values: ["single", "double", "triple", "hold"] },
        // A gesture bound to a non-existent intent is a dead button, so check it
        // against the shared registry instead of accepting any string.
        action: { kind: "intentName" },
      },
    },
  },

  privacy: {
    kind: "object",
    shape: bools([
      "allowContacts",
      "allowNotifications",
      "allowLocation",
      "allowCamera",
      "storeConversations",
    ]),
  },
  offline: { kind: "object", shape: bools(["allowLocalCommands"]) },
  accessibility: {
    kind: "object",
    shape: bools([
      "voiceFirst",
      "spokenNotifications",
      "spokenCallers",
      "verboseDescriptions",
    ]),
  },
};

const ALLOWED_FIELDS = Object.keys(FIELD_SPECS);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// BCP-47-ish: "hi-IN", "en", "bn-IN". Deliberately loose — we support languages the
// TTS vendor does not, and rejecting an unknown-but-well-formed tag helps nobody.
function isLanguageCode(v) {
  return typeof v === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(v.trim());
}

/**
 * Validate one value against a spec. Returns the cleaned value, or undefined when it
 * was rejected (in which case `errors` / `unknown` say why). `unknown` collects full
 * dotted paths so the 400 can name "privacy.allowMicrophone", not just "privacy".
 */
function clean(path, spec, value, errors, unknown) {
  switch (spec.kind) {
    case "langCode": {
      if (!isLanguageCode(value)) {
        errors.push(`${path} must be a language code like "hi-IN" or "en"`);
        return undefined;
      }
      return value.trim();
    }
    case "enum": {
      if (typeof value !== "string" || !spec.values.includes(value)) {
        errors.push(`${path} must be one of: ${spec.values.join(", ")}`);
        return undefined;
      }
      return value;
    }
    case "intentName": {
      if (typeof value !== "string" || !value.trim()) {
        errors.push(`${path} must be an intent name`);
        return undefined;
      }
      const name = value.trim();
      if (intentNames && !intentNames.includes(name)) {
        errors.push(`${path} must be a known intent name (got "${name}")`);
        return undefined;
      }
      return name;
    }
    case "string": {
      if (typeof value !== "string") {
        errors.push(`${path} must be a string`);
        return undefined;
      }
      const s = value.trim();
      if (!s) {
        errors.push(`${path} must not be empty`);
        return undefined;
      }
      if (s.length > spec.max) {
        errors.push(`${path} must be at most ${spec.max} characters`);
        return undefined;
      }
      return s;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        errors.push(`${path} must be a boolean`);
        return undefined;
      }
      return value;
    }
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        errors.push(`${path} must be a number`);
        return undefined;
      }
      if (spec.min !== undefined && n < spec.min) {
        errors.push(`${path} must be >= ${spec.min}`);
        return undefined;
      }
      if (spec.max !== undefined && n > spec.max) {
        errors.push(`${path} must be <= ${spec.max}`);
        return undefined;
      }
      return n;
    }
    case "object": {
      let raw = value;
      if (!isPlainObject(raw)) {
        raw = spec.coerceScalar ? spec.coerceScalar(value) : undefined;
        if (!isPlainObject(raw)) {
          errors.push(`${path} must be a JSON object`);
          return undefined;
        }
      }
      const out = {};
      for (const [key, sub] of Object.entries(raw)) {
        const subSpec = spec.shape[key];
        if (!subSpec) {
          unknown.push(`${path}.${key}`);
          continue;
        }
        if (sub === undefined) continue;
        const cleaned = clean(`${path}.${key}`, subSpec, sub, errors, unknown);
        if (cleaned !== undefined) out[key] = cleaned;
      }
      for (const [key, subSpec] of Object.entries(spec.shape)) {
        if (subSpec.required && out[key] === undefined) {
          errors.push(`${path}.${key} is required`);
        }
      }
      // An empty object is a no-op patch (store.js drops empty branches anyway);
      // flag it so the caller is not told "updated" when nothing changed.
      if (Object.keys(out).length === 0) {
        errors.push(`${path} contained no recognised settings`);
        return undefined;
      }
      return out;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array`);
        return undefined;
      }
      if (value.length > spec.maxItems) {
        errors.push(`${path} may contain at most ${spec.maxItems} entries`);
        return undefined;
      }
      const before = errors.length;
      const out = [];
      value.forEach((item, i) => {
        const cleaned = clean(`${path}[${i}]`, spec.item, item, errors, unknown);
        if (cleaned !== undefined) out.push(cleaned);
      });
      // Arrays replace wholesale in store.js, so a partially-valid array must not be
      // written: half a rule set is worse than a rejected request.
      return errors.length > before ? undefined : out;
    }
    default:
      unknown.push(path);
      return undefined;
  }
}

function buildPreferencePatch(bodyIn) {
  const patch = {};
  const unknown = [];
  const errors = [];

  for (const [key, value] of Object.entries(bodyIn || {})) {
    const spec = FIELD_SPECS[key];
    if (!spec) {
      unknown.push(key);
      continue;
    }
    if (value === undefined) continue;
    const cleaned = clean(key, spec, value, errors, unknown);
    if (cleaned !== undefined) patch[key] = cleaned;
  }

  return { patch, unknown, errors };
}

/* ------------------------------------------------------------------ *
 * Ephemeral telemetry store
 * ------------------------------------------------------------------ */

const deviceState = new Map(); // deviceId -> snapshot
const MAX_TRACKED_DEVICES = 500; // bounded so a fuzzing client cannot grow this forever
const STALE_AFTER_MS = 60_000; // a snapshot older than this is not "live" any more

function rememberState(deviceId, snapshot) {
  // Map preserves insertion order, so the first key is the least recently active.
  if (!deviceState.has(deviceId) && deviceState.size >= MAX_TRACKED_DEVICES) {
    deviceState.delete(deviceState.keys().next().value);
  }
  deviceState.delete(deviceId); // re-insert so recently-active devices sort last
  deviceState.set(deviceId, snapshot);
  return snapshot;
}

function percent(value, field, errors) {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    errors.push(`${field} must be a number between 0 and 100 (or null if unknown)`);
    return undefined;
  }
  return Math.round(n);
}

/**
 * Telemetry is forward-compatible on purpose: newer firmware reporting an extra field
 * must not 400 the whole sync (unlike preferences, where a bad key means data loss).
 * Unknown keys are dropped and echoed back under `ignoredFields` so the mismatch is
 * visible without breaking the device.
 */
function buildStateSnapshot(bodyIn) {
  const errors = [];
  const ignoredFields = [];
  const snap = {};

  const known = new Set([
    "connected",
    "battery",
    "batteryLeft",
    "batteryRight",
    "batteryCase",
    "firmware",
    "noiseMode",
    "model",
    "name",
    "inEar",
    "charging",
  ]);

  for (const key of Object.keys(bodyIn || {})) {
    if (!known.has(key)) ignoredFields.push(key);
  }

  for (const field of ["connected", "inEar", "charging"]) {
    const v = bodyIn?.[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "boolean") errors.push(`${field} must be a boolean`);
    else snap[field] = v;
  }

  for (const field of ["firmware", "model", "name"]) {
    const v = bodyIn?.[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") errors.push(`${field} must be a string`);
    else if (v.length > 80) errors.push(`${field} must be at most 80 characters`);
    else snap[field] = v.trim();
  }

  if(bodyIn?.noiseMode !== undefined && bodyIn.noiseMode !== null){
    if(!NOISE_MODES.includes(bodyIn.noiseMode)){
      errors.push(`noiseMode must be one of: ${NOISE_MODES.join(", ")}`);
    }else{
      snap.noiseMode = bodyIn.noiseMode;
    }
  }

  // Accept either { battery: { left, right, case } } or the flat aliases.
  const rawBattery = isPlainObject(bodyIn?.battery) ? bodyIn.battery : {};
  const parts = {
    left: rawBattery.left ?? bodyIn?.batteryLeft,
    right: rawBattery.right ?? bodyIn?.batteryRight,
    case: rawBattery.case ?? rawBattery.caseLevel ?? bodyIn?.batteryCase,
  };

  if (Object.values(parts).some((v) => v !== undefined)) {
    const battery = {};
    for (const [key, value] of Object.entries(parts)) {
      if (value === undefined) continue;
      const v = percent(value, `battery.${key}`, errors);
      if (v !== undefined) battery[key] = v;
    }
    snap.battery = battery;
  }

  return { snapshot: snap, errors, ignoredFields };
}

function describeState(deviceId) {
  const snap = deviceState.get(deviceId);
  if (!snap) {
    return {
      state: null,
      reported: false,
      stale: false,
      ageMs: null,
      // Say what we do NOT know rather than guessing a default.
      note: "No telemetry reported for this device yet. The phone must POST /state.",
    };
  }
  const ageMs = Date.now() - new Date(snap.receivedAt).getTime();
  const stale = ageMs > STALE_AFTER_MS;
  return {
    state: snap,
    reported: true,
    stale,
    ageMs,
    note: stale
      ? "Last report is older than 60s — treat these values as historical, not live."
      : null,
  };
}

/* ------------------------------------------------------------------ *
 * Preference fallback
 * ------------------------------------------------------------------ *
 * store.js already survives a dead Mongo via its Map fallback, but if it throws for
 * any other reason the route still must not 500 — losing the whole settings screen to
 * a storage hiccup is worse than serving defaults that are labelled as defaults.
 */
function fallbackUser(deviceId) {
  return {
    deviceId,
    preferredLanguage: "hi-IN",
    soundProfile: "balanced",
    noiseControl: "off",
  };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

// GET /api/device/:deviceId — preferences, created with defaults if absent.
router.get(
  "/:deviceId",
  wrap(async (req, res) => {
    const { deviceId } = req.params;
    try {
      const user = await users.get(deviceId);
      res.json({ user });
    } catch (err) {
      console.error("[device] users.get failed:", err.message);
      res.json({
        user: fallbackUser(deviceId),
        degraded: "preferences-store-unavailable",
        error: "Serving default preferences; your saved settings could not be read.",
      });
    }
  })
);

// PATCH /api/device/:deviceId — update whitelisted preferences.
router.patch(
  "/:deviceId",
  wrap(async (req, res) => {
    const { deviceId } = req.params;

    if (!isPlainObject(req.body)) {
      return res.status(400).json({ error: "Request body must be a JSON object" });
    }

    const { patch, unknown, errors } = buildPreferencePatch(req.body);

    if (unknown.length) {
      return res.status(400).json({
        error: `Unknown preference field(s): ${unknown.join(", ")}`,
        unknownFields: unknown,
        allowedFields: ALLOWED_FIELDS,
      });
    }
    if (errors.length) {
      return res.status(400).json({
        error: errors[0],
        details: errors,
        allowedFields: ALLOWED_FIELDS,
      });
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({
        error: "No patchable fields supplied",
        allowedFields: ALLOWED_FIELDS,
      });
    }

    try {
      const user = await users.upsert(deviceId, patch);
      res.json({
        user,
        updatedFields: Object.keys(patch),
        // Preference stored — NOT "earbuds reconfigured". The phone applies it.
        note: "Preference saved. The phone must apply it to the earbuds and report back.",
      });
    } catch (err) {
      console.error("[device] users.upsert failed:", err.message);
      res.status(503).json({
        saved: false,
        error: "Preferences could not be saved right now. Please retry.",
        degraded: "preferences-store-unavailable",
        detail: err.message,
      });
    }
  })
);

// GET /api/device/:deviceId/state — last telemetry snapshot the phone reported.
router.get("/:deviceId/state", (req, res) => {
  const { deviceId } = req.params;
  res.json({ deviceId, ...describeState(deviceId) });
});

// POST /api/device/:deviceId/state — the phone pushing live earbud telemetry.
// Body: { connected?, battery?: { left, right, case }, firmware?, noiseMode?, ... }
router.post("/:deviceId/state", (req, res) => {
  const { deviceId } = req.params;

  if (!isPlainObject(req.body)) {
    return res.status(400).json({ error: "Request body must be a JSON object" });
  }

  const { snapshot, errors, ignoredFields } = buildStateSnapshot(req.body);

  if (errors.length) {
    return res.status(400).json({ error: errors[0], details: errors });
  }
  if (Object.keys(snapshot).length === 0) {
    return res.status(400).json({
      error: "No recognised telemetry fields supplied",
      allowedFields: [
        "connected",
        "battery{left,right,case}",
        "firmware",
        "noiseMode",
        "model",
        "name",
        "inEar",
        "charging",
      ],
      ignoredFields,
    });
  }

  // Merge over the previous snapshot: a phone may report only what changed.
  const previous = deviceState.get(deviceId) || {};
  const stored = rememberState(deviceId, {
    ...previous,
    ...snapshot,
    battery: { ...(previous.battery || {}), ...(snapshot.battery || {}) },
    deviceId,
    receivedAt: new Date().toISOString(),
    source: "client-report", // reported BY the phone, never measured by the server
  });

  res.json({
    deviceId,
    state: stored,
    reported: true,
    stale: false,
    ageMs: 0,
    ...(ignoredFields.length ? { ignoredFields } : {}),
  });
});

export default router;
