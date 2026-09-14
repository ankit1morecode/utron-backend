/**
 * ULTRON AIR — long-term user memory ("remember that my flight is at 6").
 *
 * Backed by services/store.js, which persists to Mongo when it is up and falls back
 * to an in-process Map when it is not, so the demo never dies on a missing database.
 * Routes talk to the repository only — never to mongoose models.
 *
 * PRIVACY: the product spec promises user-controlled memory, so the destructive
 * "forget everything about me" control (DELETE /user/:userId) is a first-class route,
 * not an admin-only afterthought. Deletion is reported honestly: if we could only
 * remove part of the history, `complete` comes back false and the caller is told.
 */

import { Router } from "express";
import { memories } from "../services/store.js";
import { asyncHandler, validateBody } from "../middleware/index.js";

const router = Router();

const wrap =
  typeof asyncHandler === "function"
    ? asyncHandler
    : (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Shared validator is the coarse first pass; the semantic checks below are the real
// guarantee. If validateBody ever returns a non-middleware, degrade to a no-op rather
// than crashing the router at import time.
function body(rules) {
  const mw = typeof validateBody === "function" ? validateBody(rules) : null;
  return typeof mw === "function" ? mw : (req, res, next) => next();
}

const MAX_TEXT = 2000;
const MAX_TAGS = 12;
const MAX_TAG_LEN = 40;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const KINDS = ["note", "fact", "preference", "reminder", "contact", "task"];
const SOURCES = ["app", "voice", "auto", "import"];

// Mongo docs expose _id; the Map fallback exposes id. Normalise once, here.
const idOf = (entry) => String(entry?.id ?? entry?._id ?? "");

function clampLimit(raw, fallback, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function normalizeTags(raw, errors) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push("tags must be an array of strings");
    return [];
  }
  if (raw.length > MAX_TAGS) {
    errors.push(`tags must contain at most ${MAX_TAGS} entries`);
    return [];
  }
  const out = [];
  for (const tag of raw) {
    if (typeof tag !== "string" || !tag.trim()) {
      errors.push("each tag must be a non-empty string");
      return [];
    }
    if (tag.trim().length > MAX_TAG_LEN) {
      errors.push(`each tag must be at most ${MAX_TAG_LEN} characters`);
      return [];
    }
    const clean = tag.trim().toLowerCase();
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

// POST /api/memory  { userId, text, kind?, tags?, source? }
router.post(
  "/",
  body({
    userId: { type: "string", required: true, max: 128 },
    text: { type: "string", required: true, max: MAX_TEXT },
  }),
  wrap(async (req, res) => {
    const { userId, text, kind = "note", tags, source = "app" } = req.body || {};
    const errors = [];

    if (typeof userId !== "string" || !userId.trim()) {
      errors.push("userId is required");
    }
    if (typeof text !== "string" || !text.trim()) {
      errors.push("text is required");
    } else if (text.trim().length > MAX_TEXT) {
      errors.push(`text must be at most ${MAX_TEXT} characters`);
    }
    if (!KINDS.includes(kind)) {
      errors.push(`kind must be one of: ${KINDS.join(", ")}`);
    }
    if (!SOURCES.includes(source)) {
      errors.push(`source must be one of: ${SOURCES.join(", ")}`);
    }
    const cleanTags = normalizeTags(tags, errors);

    if (errors.length) {
      return res.status(400).json({ saved: false, error: errors[0], details: errors });
    }

    try {
      const entry = await memories.add(userId.trim(), text.trim(), {
        kind,
        tags: cleanTags,
        source,
      });
      res.json({ saved: true, entry });
    } catch (err) {
      console.error("[memory] add failed:", err.message);
      // Never claim a save that did not happen — the app shows "saved" off this flag.
      res.status(503).json({
        saved: false,
        error: "Memory could not be saved right now. Please try again.",
        degraded: "memory-store-unavailable",
        detail: err.message,
      });
    }
  })
);

// GET /api/memory/:userId/search?q=&limit=  — declared before /:userId for clarity
// (Express would not confuse them anyway: different segment counts).
router.get(
  "/:userId/search",
  wrap(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      return res.status(400).json({ entries: [], error: "q (search query) is required" });
    }

    const limit = clampLimit(req.query.limit, 10, 50);

    try {
      const entries = await memories.search(req.params.userId, q, limit);
      res.json({ entries: entries || [], query: q, count: (entries || []).length });
    } catch (err) {
      console.error("[memory] search failed:", err.message);
      res.json({
        entries: [],
        query: q,
        count: 0,
        degraded: "memory-store-unavailable",
        error: "Memory search is unavailable right now.",
      });
    }
  })
);

// GET /api/memory/:userId?limit=  — newest first
router.get(
  "/:userId",
  wrap(async (req, res) => {
    const limit = clampLimit(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);

    try {
      const entries = await memories.list(req.params.userId, limit);
      res.json({ entries: entries || [], count: (entries || []).length, limit });
    } catch (err) {
      console.error("[memory] list failed:", err.message);
      // Degrade to an empty list with a flag: the app can still render, and it knows
      // the emptiness means "unavailable", not "you have no memories".
      res.json({
        entries: [],
        count: 0,
        limit,
        degraded: "memory-store-unavailable",
        error: "Stored memories could not be read right now.",
      });
    }
  })
);

// DELETE /api/memory/user/:userId — the "forget everything about me" privacy control.
// Two path segments, so it can never be shadowed by DELETE /:id.
router.delete(
  "/user/:userId",
  wrap(async (req, res) => {
    const { userId } = req.params;
    const dryRun = req.query.dryRun === "true" || req.query.dryRun === "1";

    // The repository contract has no bulk delete, so drain in batches. Bounded passes
    // and a progress check prevent an infinite loop if remove() starts returning false.
    const BATCH = 100;
    const MAX_PASSES = 40; // 4000 entries — plenty for a personal assistant
    let deleted = 0;
    let failed = 0;
    let complete = false;

    try {
      if (dryRun) {
        const preview = await memories.list(userId, MAX_LIMIT);
        return res.json({
          deleted: 0,
          pending: (preview || []).length,
          dryRun: true,
          note: "Nothing was deleted. Re-issue without ?dryRun=true to erase.",
        });
      }

      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        const batch = await memories.list(userId, BATCH);
        if (!batch || batch.length === 0) {
          complete = true;
          break;
        }

        let progressed = false;
        for (const entry of batch) {
          const id = idOf(entry);
          if (!id) {
            failed += 1;
            continue;
          }
          const ok = await memories.remove(id);
          if (ok) {
            deleted += 1;
            progressed = true;
          } else {
            failed += 1;
          }
        }

        // Nothing removable left that we can act on — stop rather than spin.
        if (!progressed) break;
        if (batch.length < BATCH) {
          complete = true;
          break;
        }
      }

      res.json({
        deleted,
        complete,
        ...(failed ? { failed } : {}),
        // Say plainly whether the erase finished; a half-done privacy action that
        // reports success is exactly the kind of claim this backend must not make.
        note: complete
          ? "All stored memories for this user were deleted."
          : "Some memories may remain. Call this endpoint again to continue erasing.",
      });
    } catch (err) {
      console.error("[memory] bulk delete failed:", err.message);
      res.status(503).json({
        deleted,
        complete: false,
        error: "Memories could not be fully erased. Please retry.",
        degraded: "memory-store-unavailable",
        detail: err.message,
      });
    }
  })
);

// DELETE /api/memory/:id — forget one thing
router.delete(
  "/:id",
  wrap(async (req, res) => {
    try {
      const deleted = await memories.remove(req.params.id);
      // 404 when nothing matched, so "deleted: true" always means it really went.
      if (!deleted) {
        return res.status(404).json({ deleted: false, error: "No memory with that id" });
      }
      res.json({ deleted: true });
    } catch (err) {
      console.error("[memory] remove failed:", err.message);
      res.status(503).json({
        deleted: false,
        error: "Memory could not be deleted right now. Please retry.",
        degraded: "memory-store-unavailable",
        detail: err.message,
      });
    }
  })
);

export default router;
