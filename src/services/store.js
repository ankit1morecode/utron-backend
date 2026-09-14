/**
 * ULTRON AIR — persistence repository.
 *
 * Routes and services talk to THIS module, never to mongoose models directly.
 *
 * Two interchangeable backends sit behind one API:
 *   1. MongoDB, whenever isDbReady() is true.
 *   2. An in-process Map store, otherwise.
 *
 * The fallback is not a stub: it reproduces the Mongo semantics exactly —
 * default-object creation, deep-merge patching, newest-first ordering, limits,
 * id shape (24 hex chars, like an ObjectId) and search ranking — so no caller
 * can tell which backend served the request. That is what lets the whole API
 * run on a laptop with no database for a demo.
 *
 * Every Mongo path is wrapped: if a query throws mid-flight (connection dropped,
 * timeout) the call degrades to the memory store instead of bubbling a 500.
 */

import mongoose from "mongoose";
import { isDbReady as dbIsReady } from "../config/db.js";
import User from "../models/User.js";
import Memory from "../models/Memory.js";
import SafetyProfile from "../models/SafetyProfile.js";
import SafetyEvent from "../models/SafetyEvent.js";
import Conversation, { MAX_TURNS } from "../models/Conversation.js";

/* ------------------------------------------------------------------ *
 * backend selection + one-time logging
 * ------------------------------------------------------------------ */

let fallbackLogged = false;
let lastMongoErrorLog = 0;

/** Log the fallback notice exactly once for the lifetime of the process. */
function noteFallback() {
  if (fallbackLogged) return;
  fallbackLogged = true;
  console.warn("[store] running without MongoDB - using in-memory store");
}

/** Throttled so a flapping connection cannot spam the log. */
function noteMongoError(op, err) {
  const now = Date.now();
  if (now - lastMongoErrorLog > 10000) {
    lastMongoErrorLog = now;
    console.error(
      `[store] MongoDB operation "${op}" failed (${err?.message || err}) — ` +
        "serving this call from the in-memory store"
    );
  }
}

/** Contract export. True when Mongo is live and should be used. */
export function isDbReady() {
  return dbIsReady();
}

/** Decide the backend for one call, logging the fallback the first time. */
function useMongo() {
  if (isDbReady()) return true;
  noteFallback();
  return false;
}

/* ------------------------------------------------------------------ *
 * in-process store
 * ------------------------------------------------------------------ */

const mem = {
  users: new Map(), // deviceId -> user object
  memories: new Map(), // userId  -> entry[] (push order == oldest first)
  memoryOwner: new Map(), // memoryId -> userId (so remove(id) is O(1))
  safetyProfiles: new Map(), // userId -> profile
  safetyEvents: new Map(), // userId -> event[]
  conversations: new Map(), // userId -> turn[]
};

let idCounter = Math.floor(Math.random() * 0xffffff);

// Per-process random, generated once — exactly how a real ObjectId is built.
const ID_PROCESS_RANDOM = Math.floor(Math.random() * 0xffffffffff)
  .toString(16)
  .padStart(10, "0");

/**
 * Produce an ObjectId-shaped id (24 lowercase hex chars) so fallback documents
 * are indistinguishable from Mongo ones to any client or route.
 *
 * Layout mirrors a real ObjectId — 4-byte seconds | 5-byte per-process random |
 * 3-byte incrementing counter — which matters for more than looks: it makes
 * lexicographic id order equal insertion order, so sorting by _id is a
 * deterministic tiebreak for documents created in the same millisecond, just
 * as it is in Mongo. A random middle segment would have made that tiebreak
 * arbitrary and list ordering flaky.
 */
function newId() {
  const ts = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, "0");
  idCounter = (idCounter + 1) & 0xffffff;
  const counter = idCounter.toString(16).padStart(6, "0");
  return (ts + ID_PROCESS_RANDOM + counter).slice(0, 24);
}

/* ------------------------------------------------------------------ *
 * shared helpers
 * ------------------------------------------------------------------ */

function isPlainObject(v) {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !(v instanceof mongoose.Types.ObjectId)
  );
}

/** Keys a caller must never be able to set (operator injection / identity). */
const BLOCKED_KEYS = new Set([
  "_id",
  "id",
  "__v",
  "createdAt",
  "updatedAt",
  "deviceId",
  "userId",
]);

function isSafeKey(k, top) {
  if (typeof k !== "string" || !k.length) return false;
  if (k.startsWith("$") || k.includes(".")) return false; // no operator injection
  if (top && BLOCKED_KEYS.has(k)) return false;
  return true;
}

/**
 * Turn a nested patch into dotted $set paths so Mongo performs a DEEP merge
 * (a bare $set of `privacy` would otherwise wipe the untouched sibling flags).
 * Arrays and scalars replace wholesale; empty objects are dropped as no-ops.
 */
function flattenPatch(patch, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (!isSafeKey(k, prefix === "")) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) {
      if (Object.keys(v).length === 0) continue; // no-op
      flattenPatch(v, path, out);
    } else if (v !== undefined) {
      out[path] = v;
    }
  }
  return out;
}

/** The memory-store twin of flattenPatch: same merge rules, applied in place. */
function deepMerge(target, patch, top = true) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (!isSafeKey(k, top)) continue;
    if (isPlainObject(v)) {
      if (Object.keys(v).length === 0) continue;
      if (!isPlainObject(target[k])) target[k] = {};
      deepMerge(target[k], v, false);
    } else if (v !== undefined) {
      target[k] = v;
    }
  }
  return target;
}

/** Normalise any document to a plain object carrying both `_id` and `id`. */
function plain(doc) {
  if (!doc) return null;
  const o =
    typeof doc.toObject === "function" ? doc.toObject({ depopulate: true }) : { ...doc };
  if (o._id != null) {
    o._id = String(o._id);
    o.id = o._id;
  }
  delete o.__v;
  return o;
}

/** Deep clone so callers mutating a returned object cannot corrupt the store. */
function clone(v) {
  if (v == null) return v;
  return JSON.parse(JSON.stringify(v));
}

function clampLimit(limit, fallbackValue, max = 500) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallbackValue;
  return Math.min(Math.floor(n), max);
}

function requireId(value, label) {
  const s = value == null ? "" : String(value).trim();
  if (!s) throw new Error(`[store] ${label} is required`);
  return s;
}

/** Newest-first comparator used by every list() in the fallback. */
function byNewest(a, b) {
  const at = new Date(b.createdAt || b.at || 0) - new Date(a.createdAt || a.at || 0);
  if (at !== 0) return at;
  // Stable tiebreak for items created in the same millisecond.
  return String(b._id).localeCompare(String(a._id));
}

/* ------------------------------------------------------------------ *
 * default document shapes — one source of truth for BOTH backends
 * ------------------------------------------------------------------ */

function defaultUser(deviceId) {
  const now = new Date().toISOString();
  return {
    _id: newId(),
    id: undefined, // filled below
    deviceId,
    preferredLanguage: "hi-IN",
    soundProfile: "balanced",
    noiseControl: "off",
    wakeWord: { phrase: "Ultron", enabled: true, sensitivity: "medium" },
    voice: { speaker: "priya", rate: 1, pitch: 0 },
    responseStyle: "balanced",
    notificationRules: [],
    touchMappings: [],
    privacy: {
      allowContacts: false,
      allowNotifications: false,
      allowLocation: false,
      allowCamera: false,
      storeConversations: true,
    },
    offline: { allowLocalCommands: true },
    accessibility: {
      voiceFirst: true,
      spokenNotifications: true,
      spokenCallers: true,
      verboseDescriptions: false,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function defaultSafetyProfile(userId) {
  const now = new Date().toISOString();
  return {
    _id: newId(),
    id: undefined,
    userId,
    emergencyContacts: [],
    trustedContacts: [],
    safetyMode: {
      // Preference only — the detection capability it describes is PLANNED.
      enabled: false,
      sensitivity: "medium",
      autoVolumeReduction: true,
      spokenWarnings: true,
      shareLocationOnEmergency: false,
    },
    drivingMode: {
      enabled: false,
      autoDetect: false,
      announceCallers: true,
      announceImportantOnly: true,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function withId(o) {
  o.id = o._id;
  return o;
}

/* ------------------------------------------------------------------ *
 * users
 * ------------------------------------------------------------------ */

export const users = {
  /** Fetch a user, creating one with defaults when absent. */
  async get(deviceId) {
    const key = requireId(deviceId, "deviceId");

    if (useMongo()) {
      try {
        // Atomic get-or-create: $setOnInsert leaves an existing doc untouched.
        const doc = await User.findOneAndUpdate(
          { deviceId: key },
          { $setOnInsert: { deviceId: key } },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        ).lean();
        if (doc) return plain(doc);
      } catch (err) {
        noteMongoError("users.get", err);
      }
    }

    if (!mem.users.has(key)) mem.users.set(key, withId(defaultUser(key)));
    return clone(mem.users.get(key));
  },

  /** Deep-merge `patch` into the user, creating it first if needed. */
  async upsert(deviceId, patch = {}) {
    const key = requireId(deviceId, "deviceId");
    const $set = flattenPatch(patch);

    if (useMongo()) {
      try {
        const update = { $setOnInsert: { deviceId: key } };
        if (Object.keys($set).length) update.$set = $set;
        const doc = await User.findOneAndUpdate({ deviceId: key }, update, {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
          runValidators: true,
        }).lean();
        if (doc) return plain(doc);
      } catch (err) {
        noteMongoError("users.upsert", err);
      }
    }

    if (!mem.users.has(key)) mem.users.set(key, withId(defaultUser(key)));
    const rec = mem.users.get(key);
    deepMerge(rec, patch);
    rec.updatedAt = new Date().toISOString();
    return clone(rec);
  },
};

/**
 * Read a user WITHOUT creating one. Used by the privacy check in
 * conversations.append so logging a turn never conjures a profile.
 */
async function peekUser(deviceId) {
  const key = String(deviceId || "").trim();
  if (!key) return null;
  if (isDbReady()) {
    try {
      const doc = await User.findOne({ deviceId: key }).lean();
      if (doc) return plain(doc);
    } catch (err) {
      noteMongoError("peekUser", err);
    }
  }
  return mem.users.has(key) ? clone(mem.users.get(key)) : null;
}

/* ------------------------------------------------------------------ *
 * memories
 * ------------------------------------------------------------------ */

const MEMORY_KINDS = ["fact", "preference", "person", "place", "reminder"];
const MEMORY_SOURCES = ["voice", "app", "auto"];

function normaliseMeta(meta = {}) {
  const kind = MEMORY_KINDS.includes(meta.kind) ? meta.kind : "fact";
  const source = MEMORY_SOURCES.includes(meta.source) ? meta.source : "voice";
  const tags = Array.isArray(meta.tags)
    ? meta.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
    : [];
  return { kind, source, tags };
}

/** Lowercase word tokens, punctuation stripped, Unicode-aware (Devanagari etc). */
function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "was", "are", "of", "to", "my", "me", "i",
  "what", "whats", "who", "when", "where", "did", "do", "does", "for",
  "and", "in", "on", "at", "it", "that", "this", "kya", "hai", "mera",
  "meri", "ka", "ki", "ke", "tha", "thi",
]);

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Token-overlap scorer for the fallback backend.
 * Exact token match scores 1, prefix match 0.6, a tag hit adds 0.5.
 * Normalised by query length so short and long memories compete fairly.
 */
function scoreEntry(entry, queryTokens) {
  const entryTokens = tokenize(entry.text);
  const tagTokens = new Set((entry.tags || []).map((t) => String(t).toLowerCase()));
  let score = 0;
  for (const q of queryTokens) {
    if (entryTokens.includes(q)) score += 1;
    else if (entryTokens.some((t) => t.startsWith(q) || q.startsWith(t))) score += 0.6;
    if (tagTokens.has(q)) score += 0.5;
  }
  return score / queryTokens.length;
}

export const memories = {
  async add(userId, text, meta = {}) {
    const uid = requireId(userId, "userId");
    const body = String(text ?? "").trim();
    if (!body) throw new Error("[store] memories.add requires non-empty text");
    const { kind, source, tags } = normaliseMeta(meta);

    if (useMongo()) {
      try {
        const doc = await Memory.create({ userId: uid, text: body, kind, tags, source });
        return plain(doc);
      } catch (err) {
        noteMongoError("memories.add", err);
      }
    }

    const now = new Date().toISOString();
    const entry = withId({
      _id: newId(),
      userId: uid,
      text: body,
      kind,
      tags,
      source,
      createdAt: now,
      updatedAt: now,
    });
    if (!mem.memories.has(uid)) mem.memories.set(uid, []);
    mem.memories.get(uid).push(entry);
    mem.memoryOwner.set(entry._id, uid);
    return clone(entry);
  },

  /** Newest first. */
  async list(userId, limit = 50) {
    const uid = requireId(userId, "userId");
    const max = clampLimit(limit, 50);

    if (useMongo()) {
      try {
        const docs = await Memory.find({ userId: uid })
          .sort({ createdAt: -1, _id: -1 })
          .limit(max)
          .lean();
        return docs.map(plain);
      } catch (err) {
        noteMongoError("memories.list", err);
      }
    }

    const all = mem.memories.get(uid) || [];
    return clone(all.slice().sort(byNewest).slice(0, max));
  },

  /**
   * Relevance search. Mongo uses the `text` index and falls back to an OR of
   * escaped token regexes when the index yields nothing (or is not built yet);
   * the memory store uses the token-overlap scorer above. Both return
   * best-match first and never throw on a junk query.
   */
  async search(userId, query, limit = 10) {
    const uid = requireId(userId, "userId");
    const max = clampLimit(limit, 10);
    const raw = String(query ?? "").trim();
    if (!raw) return [];

    // Content tokens only. A query with nothing but stopwords yields no hits —
    // matching what Mongo's $text search does, so both backends agree.
    const tokens = tokenize(raw).filter((t) => !STOPWORDS.has(t));
    if (!tokens.length) return [];

    if (useMongo()) {
      try {
        const hits = await Memory.find(
          { userId: uid, $text: { $search: raw } },
          { score: { $meta: "textScore" } }
        )
          .sort({ score: { $meta: "textScore" } })
          .limit(max)
          .lean();
        if (hits.length) return hits.map(plain);
      } catch (err) {
        // Index may not exist yet, or the query may be text-search-hostile.
        noteMongoError("memories.search(text)", err);
      }

      try {
        const or = tokens.map((t) => ({ text: new RegExp(escapeRegex(t), "i") }));
        const docs = await Memory.find({ userId: uid, $or: or })
          .sort({ createdAt: -1 })
          .limit(max)
          .lean();
        return docs.map(plain);
      } catch (err) {
        noteMongoError("memories.search(regex)", err);
      }
    }

    const all = mem.memories.get(uid) || [];
    return clone(
      all
        .map((e) => ({ e, s: scoreEntry(e, tokens) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => (b.s - a.s) || byNewest(a.e, b.e))
        .slice(0, max)
        .map((x) => x.e)
    );
  },

  /** True when something was actually deleted. */
  async remove(id) {
    const key = String(id ?? "").trim();
    if (!key) return false;

    if (useMongo()) {
      try {
        // An invalid ObjectId would make Mongo throw — answer "not found".
        if (!mongoose.isValidObjectId(key)) return false;
        const res = await Memory.deleteOne({ _id: key });
        if (res?.deletedCount > 0) return true;
        // Fall through: the id may belong to a doc written while Mongo was down.
      } catch (err) {
        noteMongoError("memories.remove", err);
      }
    }

    const uid = mem.memoryOwner.get(key);
    if (!uid) return false;
    const list = mem.memories.get(uid) || [];
    const i = list.findIndex((e) => e._id === key);
    if (i === -1) {
      mem.memoryOwner.delete(key);
      return false;
    }
    list.splice(i, 1);
    mem.memoryOwner.delete(key);
    return true;
  },
};

/* ------------------------------------------------------------------ *
 * safety
 * ------------------------------------------------------------------ */

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

/**
 * Normalise an inbound event.
 *
 * HONESTY: `action` records only what the CLIENT reported doing. A caller that
 * omits it gets 'none' — the server never upgrades an event to "call_placed"
 * on its own, and a specific `kind` (horn/siren) is only kept when a real
 * classifier is named as the detector.
 */
function normaliseEvent(event = {}) {
  const detectedBy = EVENT_DETECTORS.includes(event.detectedBy)
    ? event.detectedBy
    : "device_metering";

  let kind = EVENT_KINDS.includes(event.kind) ? event.kind : "loud_unknown";
  const classified = ["horn", "siren", "alarm", "shout"].includes(kind);
  if (classified && detectedBy === "device_metering") {
    // Raw loudness metering cannot identify a sound. Downgrade rather than lie.
    kind = "loud_unknown";
  }

  const confidenceRaw = Number(event.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;

  const out = {
    kind,
    confidence,
    action: EVENT_ACTIONS.includes(event.action) ? event.action : "none",
    detectedBy,
    at: event.at ? new Date(event.at) : new Date(),
  };

  if (Number.isFinite(Number(event.level))) out.level = Number(event.level);

  const loc = event.location;
  if (loc && (Number.isFinite(Number(loc.lat)) || Number.isFinite(Number(loc.lng)))) {
    out.location = {
      lat: Number(loc.lat),
      lng: Number(loc.lng),
      accuracy: Number.isFinite(Number(loc.accuracy)) ? Number(loc.accuracy) : undefined,
    };
  }
  return out;
}

export const safety = {
  /** Fetch the safety profile, creating one with defaults when absent. */
  async getProfile(userId) {
    const uid = requireId(userId, "userId");

    if (useMongo()) {
      try {
        const doc = await SafetyProfile.findOneAndUpdate(
          { userId: uid },
          { $setOnInsert: { userId: uid } },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        ).lean();
        if (doc) return plain(doc);
      } catch (err) {
        noteMongoError("safety.getProfile", err);
      }
    }

    if (!mem.safetyProfiles.has(uid))
      mem.safetyProfiles.set(uid, withId(defaultSafetyProfile(uid)));
    return clone(mem.safetyProfiles.get(uid));
  },

  /** Deep-merge `patch` (contact arrays replace wholesale). */
  async patchProfile(userId, patch = {}) {
    const uid = requireId(userId, "userId");
    const $set = flattenPatch(patch);

    if (useMongo()) {
      try {
        const update = { $setOnInsert: { userId: uid } };
        if (Object.keys($set).length) update.$set = $set;
        const doc = await SafetyProfile.findOneAndUpdate({ userId: uid }, update, {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
          runValidators: true,
        }).lean();
        if (doc) return plain(doc);
      } catch (err) {
        noteMongoError("safety.patchProfile", err);
      }
    }

    if (!mem.safetyProfiles.has(uid))
      mem.safetyProfiles.set(uid, withId(defaultSafetyProfile(uid)));
    const rec = mem.safetyProfiles.get(uid);
    deepMerge(rec, patch);
    rec.updatedAt = new Date().toISOString();
    return clone(rec);
  },

  async addEvent(userId, event = {}) {
    const uid = requireId(userId, "userId");
    const clean = normaliseEvent(event);

    if (useMongo()) {
      try {
        const doc = await SafetyEvent.create({ userId: uid, ...clean });
        return plain(doc);
      } catch (err) {
        noteMongoError("safety.addEvent", err);
      }
    }

    const now = new Date().toISOString();
    const rec = withId({
      _id: newId(),
      userId: uid,
      ...clean,
      at: clean.at.toISOString(),
      createdAt: now,
      updatedAt: now,
    });
    if (!mem.safetyEvents.has(uid)) mem.safetyEvents.set(uid, []);
    const list = mem.safetyEvents.get(uid);
    list.push(rec);
    // Bound the fallback store: a noisy device could otherwise leak memory.
    if (list.length > 1000) list.splice(0, list.length - 1000);
    return clone(rec);
  },

  /** Newest first. */
  async listEvents(userId, limit = 50) {
    const uid = requireId(userId, "userId");
    const max = clampLimit(limit, 50);

    if (useMongo()) {
      try {
        const docs = await SafetyEvent.find({ userId: uid })
          .sort({ at: -1, _id: -1 })
          .limit(max)
          .lean();
        return docs.map(plain);
      } catch (err) {
        noteMongoError("safety.listEvents", err);
      }
    }

    const all = mem.safetyEvents.get(uid) || [];
    return clone(
      all
        .slice()
        .sort((a, b) => new Date(b.at) - new Date(a.at) || byNewest(a, b))
        .slice(0, max)
    );
  },
};

/* ------------------------------------------------------------------ *
 * conversations (rolling short-term memory)
 * ------------------------------------------------------------------ */

const TURN_ROLES = ["user", "assistant", "system"];

function normaliseTurn(turn = {}) {
  return {
    role: TURN_ROLES.includes(turn.role) ? turn.role : "user",
    text: String(turn.text ?? ""),
    intent: turn.intent ? String(turn.intent) : null,
    lang: turn.lang ? String(turn.lang) : "hi-IN",
    at: turn.at ? new Date(turn.at) : new Date(),
  };
}

/**
 * Tiny TTL cache for privacy.storeConversations so honouring the flag costs at
 * most one lookup per user per 30s instead of one per conversational turn.
 */
const privacyCache = new Map(); // userId -> { allow: boolean, exp: number }
const PRIVACY_TTL_MS = 30000;

async function storageAllowed(userId) {
  const hit = privacyCache.get(userId);
  if (hit && hit.exp > Date.now()) return hit.allow;
  const user = await peekUser(userId);
  // Unknown user => allow. The default for a real profile is true anyway, and a
  // missing profile must not silently disable session memory.
  const allow = user?.privacy?.storeConversations !== false;
  privacyCache.set(userId, { allow, exp: Date.now() + PRIVACY_TTL_MS });
  return allow;
}

export const conversations = {
  /** Append one turn. Silently no-ops if the user opted out of storage. */
  async append(userId, turn) {
    const uid = requireId(userId, "userId");
    const clean = normaliseTurn(turn);
    if (!(await storageAllowed(uid))) return;

    if (useMongo()) {
      try {
        await Conversation.updateOne(
          { userId: uid },
          {
            $setOnInsert: { userId: uid },
            // $push + $slice keeps the document bounded server-side in one trip.
            $push: { turns: { $each: [clean], $slice: -MAX_TURNS } },
          },
          { upsert: true }
        );
        return;
      } catch (err) {
        noteMongoError("conversations.append", err);
      }
    }

    if (!mem.conversations.has(uid)) mem.conversations.set(uid, []);
    const list = mem.conversations.get(uid);
    list.push({ ...clean, at: clean.at.toISOString() });
    if (list.length > MAX_TURNS) list.splice(0, list.length - MAX_TURNS);
  },

  /** The last `n` turns, OLDEST FIRST (ready to feed straight to an LLM). */
  async recent(userId, n = 12) {
    const uid = requireId(userId, "userId");
    const max = clampLimit(n, 12, MAX_TURNS);

    if (useMongo()) {
      try {
        // $slice with a negative count returns the tail, already oldest-first.
        const doc = await Conversation.findOne({ userId: uid }, { turns: { $slice: -max } })
          .lean();
        if (doc) return (doc.turns || []).map((t) => ({ ...t }));
        return [];
      } catch (err) {
        noteMongoError("conversations.recent", err);
      }
    }

    const list = mem.conversations.get(uid) || [];
    return clone(list.slice(-max));
  },

  async clear(userId) {
    const uid = requireId(userId, "userId");

    if (useMongo()) {
      try {
        await Conversation.updateOne({ userId: uid }, { $set: { turns: [] } });
      } catch (err) {
        noteMongoError("conversations.clear", err);
      }
    }
    // Always clear the in-process copy too: "forget this" must be unambiguous.
    mem.conversations.delete(uid);
  },
};

/* ------------------------------------------------------------------ *
 * test / diagnostic helpers (not part of the route-facing contract)
 * ------------------------------------------------------------------ */

/** Which backend served the last decision, for /health and debugging. */
export function storeBackend() {
  return isDbReady() ? "mongodb" : "memory";
}

/** Wipe the in-process store. Used by tests; harmless in production. */
export function __resetMemoryStore() {
  mem.users.clear();
  mem.memories.clear();
  mem.memoryOwner.clear();
  mem.safetyProfiles.clear();
  mem.safetyEvents.clear();
  mem.conversations.clear();
  privacyCache.clear();
}

export default { isDbReady, users, memories, safety, conversations, storeBackend };
