// ULTRON AIR — assistant route.
//
// This is the single door the mobile app knocks on for the whole voice loop:
//   VOICE -> SPEECH RECOGNITION -> INTENT -> CONTEXT -> PLAN -> ACTION -> RESPONSE
//
// Division of responsibility (this is the honesty contract of the product):
//   * The SERVER transcribes, understands, remembers and PLANS actions.
//   * The PHONE executes them (placing calls, changing volume, reading notifications).
//   * The phone then calls POST /report to say what actually happened.
// Therefore no reply produced here may ever claim a device action succeeded. The only
// endpoint allowed to say "done" is /report, and only because the client told us so.

import { Router } from "express";

import { asyncHandler, validateBody } from "../middleware/index.js";
import { runTurn } from "../services/orchestrator.js";
import { textToSpeech, speechToText, isSarvamConfigured } from "../services/sarvam.js";
import { resetSession } from "../services/gemini.js";
import { conversations, safety } from "../services/store.js";
import { INTENT_REGISTRY, INTENT_NAMES, getIntent } from "../services/intents.js";

const router = Router();

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

// A spoken command longer than this is not a command, it is a bug: a stuck mic,
// a runaway loop on the client, or somebody pasting a novel.
const MAX_TEXT_CHARS = 2000;

// ~8MB of base64. Base64 characters map roughly 1:1 to bytes of payload, so this is
// a close-enough ceiling and keeps us from buffering huge blobs in memory.
const MAX_AUDIO_B64_CHARS = 8 * 1024 * 1024;

// NOTE: src/index.js installs express.json({ limit: "2mb" }) globally. body-parser marks
// the request as already parsed, so a router-level parser with a bigger limit would be
// skipped — raising the ceiling for /turn audio has to happen in index.js. Until it does,
// oversized audio is rejected by the global parser (express's own 413) and the checks
// below are the second line of defence.

// Must match the mobile app exactly.
const PERMISSION_KEYS = [
  "microphone",
  "bluetooth",
  "contacts",
  "notifications",
  "location",
  "camera",
  "phone",
  "mediaControl",
];

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Uniform 413-style payload rejection, so the client can show a real message. */
function payloadTooLarge(res, field, actual, limit, hint) {
  return res.status(413).json({
    error: "payload_too_large",
    field,
    limit,
    actual,
    message: `"${field}" is ${actual} units, limit is ${limit}. ${hint}`,
  });
}

/** Accept "hi" or "hi-IN"; always hand downstream services a full BCP-47-ish tag. */
function normalizeLanguage(code) {
  if (typeof code !== "string" || !code.trim()) return "hi-IN";
  const raw = code.trim();
  if (raw.includes("-")) return raw;
  return `${raw.toLowerCase()}-IN`;
}

/** Degradation notes accumulate — one turn can lose both Gemini and Sarvam. */
function mergeDegraded(existing, note) {
  if (!note) return existing || null;
  if (!existing) return note;
  if (existing.includes(note)) return existing;
  return `${existing}; ${note}`;
}

/**
 * Minimal phrase table. Real localisation comes out of the model, but cancellations
 * and failure lines must still work when Gemini is unreachable, so they live here.
 */
const PHRASES = {
  hi: {
    cancelled: "ठीक है, मैंने वह रद्द कर दिया।",
    sending: "ठीक है, मैं इसे आपके फ़ोन पर भेज रहा हूँ। हो जाने पर बता दूँगा।",
    didNotCatch: "माफ़ कीजिए, मैं सुन नहीं पाया। फिर से कहिए।",
    thinkingFailed: "अभी मैं जवाब नहीं बना पा रहा हूँ। थोड़ी देर में फिर कोशिश कीजिए।",
    reportDone: "हो गया।",
    reportFailed: "यह आपके फ़ोन पर पूरा नहीं हो पाया।",
    reset: "ठीक है, मैंने हमारी बातचीत भुला दी।",
  },
  en: {
    cancelled: "Okay, I have cancelled that.",
    sending: "Okay, sending that to your phone now. I will tell you once it confirms.",
    didNotCatch: "Sorry, I did not catch that. Could you say it again?",
    thinkingFailed: "I cannot work that out right now. Give me a moment and try again.",
    reportDone: "Done.",
    reportFailed: "That did not go through on your phone.",
    reset: "Okay, I have cleared our conversation.",
  },
};

function phrase(languageCode, key) {
  const lang = normalizeLanguage(languageCode).split("-")[0].toLowerCase();
  const table = PHRASES[lang] || PHRASES.en;
  return table[key] || PHRASES.en[key];
}

/**
 * Speak `text` unless the caller opted out. A dead TTS provider must never cost us the
 * turn — the app can fall back to on-device speech synthesis, so we hand back
 * audio:null plus a degraded note and a 200.
 */
async function speakOrDegrade(text, languageCode, speak, opts = {}) {
  if (speak === false) return { audio: null, degraded: null };
  if (!text || !String(text).trim()) return { audio: null, degraded: null };
  if (!isSarvamConfigured()) {
    return { audio: null, degraded: "tts_unavailable:SARVAM_API_KEY is not set" };
  }
  try {
    const audio = await textToSpeech(String(text), normalizeLanguage(languageCode), opts);
    if (!audio) return { audio: null, degraded: "tts_unavailable:sarvam returned no audio" };
    return { audio, degraded: null };
  } catch (err) {
    console.error("[assistant] Sarvam TTS failed:", err.message);
    return { audio: null, degraded: `tts_unavailable:${err.message}` };
  }
}

/**
 * Guarantee the full TurnResult shape no matter what the orchestrator returned. The
 * mobile app destructures these fields; a missing `actions` array there is a crash in
 * someone's ear, so normalise here rather than trusting upstream.
 */
function normalizeTurn(result = {}, defaults = {}) {
  const r = result && typeof result === "object" ? result : {};
  return {
    transcript: r.transcript ?? defaults.transcript ?? null,
    intent: r.intent ?? "unknown",
    confidence: typeof r.confidence === "number" ? r.confidence : 0,
    contextUsed: r.contextUsed ?? {},
    plan: Array.isArray(r.plan) ? r.plan : [],
    actions: Array.isArray(r.actions) ? r.actions : [],
    reply: r.reply ?? defaults.reply ?? "",
    needsConfirmation: r.needsConfirmation === true,
    needsPermission: Array.isArray(r.needsPermission) ? r.needsPermission : [],
    followUp: r.followUp ?? null,
    fallback: r.fallback === true,
    error: r.error ?? null,
    degraded: r.degraded ?? null,
  };
}

/** A complete, honest TurnResult for when the pipeline itself fell over. */
function fallbackTurn({ transcript = null, reply, error = null, degraded = null }) {
  return normalizeTurn({
    transcript,
    intent: "unknown",
    confidence: 0,
    contextUsed: {},
    plan: [],
    actions: [], // nothing was planned, so nothing may be claimed
    reply,
    needsConfirmation: false,
    needsPermission: [],
    followUp: null,
    fallback: true,
    error,
    degraded,
  });
}

/** Human-readable label for an intent, used in spoken acknowledgements. */
function intentLabel(name) {
  let intent = null;
  try {
    intent = typeof getIntent === "function" ? getIntent(name) : null;
  } catch {
    intent = null;
  }
  if (intent?.description) return intent.description;
  if (typeof name === "string" && name) return name.replace(/_/g, " ");
  return "that";
}

/* ------------------------------------------------------------------ *
 * Size guards — mounted BEFORE validateBody so a 413 wins over a 400
 * ------------------------------------------------------------------ */

function enforceTurnLimits(req, res, next) {
  const body = req.body || {};
  if (typeof body.text === "string" && body.text.length > MAX_TEXT_CHARS) {
    return payloadTooLarge(res, "text", body.text.length, MAX_TEXT_CHARS, "Send a shorter command.");
  }
  if (typeof body.audioBase64 === "string" && body.audioBase64.length > MAX_AUDIO_B64_CHARS) {
    return payloadTooLarge(
      res,
      "audioBase64",
      body.audioBase64.length,
      MAX_AUDIO_B64_CHARS,
      "Record a shorter clip (about 8MB of base64 at most) or send it in chunks."
    );
  }
  return next();
}

/* ------------------------------------------------------------------ *
 * POST /api/assistant/turn — the main endpoint
 * ------------------------------------------------------------------ */

router.post(
  "/turn",
  enforceTurnLimits,
  validateBody({
    userId: { type: "string", required: true, max: 128 },
    text: { type: "string" },
    audioBase64: { type: "string" },
    languageCode: { type: "string", max: 16 },
    context: { type: "object" },
    confirm: { type: "boolean" },
    speak: { type: "boolean" },
    // Sarvam STT defaults to audio/wav, but expo-av records .m4a on Android — the client
    // must be able to declare what it actually recorded or every transcription fails.
    mimeType: { type: "string", max: 64 },
    fileName: { type: "string", max: 128 },
  }),
  asyncHandler(async (req, res) => {
    const {
      userId,
      text: rawText,
      audioBase64,
      context = {},
      confirm = null,
      speak = true,
      mimeType,
      fileName,
    } = req.body || {};

    const languageCode = normalizeLanguage(req.body?.languageCode);

    const hasText = typeof rawText === "string" && rawText.trim().length > 0;
    const hasAudio = typeof audioBase64 === "string" && audioBase64.trim().length > 0;

    if (!hasText && !hasAudio) {
      return res.status(400).json({
        error: "bad_request",
        message: "Provide either `text` or `audioBase64`.",
      });
    }

    let transcript = hasText ? rawText.trim() : null;
    let sttLanguage = languageCode;
    let degraded = null;

    // ---- 1. SPEECH RECOGNITION (only when the client sent raw audio) ----
    if (!hasText && hasAudio) {
      if (!isSarvamConfigured()) {
        // No STT and no text means there is genuinely nothing to reason about. Still a
        // 200: the app should ask the user to repeat, not show an error screen.
        const reply = phrase(languageCode, "didNotCatch");
        const spoken = await speakOrDegrade(reply, languageCode, speak);
        return res.json({
          ...fallbackTurn({
            reply,
            error: "SARVAM_API_KEY is not set on the server; speech recognition is unavailable",
            degraded: mergeDegraded("stt_unavailable:SARVAM_API_KEY is not set", spoken.degraded),
          }),
          transcript: null,
          audio: spoken.audio,
          languageCode,
        });
      }

      try {
        const sttOpts = {};
        if (mimeType) sttOpts.mimeType = mimeType;
        if (fileName) sttOpts.fileName = fileName;
        const stt = await speechToText(audioBase64, languageCode, sttOpts);
        transcript = (stt?.transcript || "").trim();
        sttLanguage = normalizeLanguage(stt?.languageCode || languageCode);
      } catch (err) {
        console.error("[assistant] Sarvam STT failed:", err.message);
        const reply = phrase(languageCode, "didNotCatch");
        const spoken = await speakOrDegrade(reply, languageCode, speak);
        return res.json({
          ...fallbackTurn({
            reply,
            error: `Sarvam STT failed: ${err.message}`,
            degraded: mergeDegraded(`stt_failed:${err.message}`, spoken.degraded),
          }),
          transcript: null,
          audio: spoken.audio,
          languageCode,
        });
      }

      if (!transcript) {
        // Clean transcription, empty result: silence or background noise.
        const reply = phrase(sttLanguage, "didNotCatch");
        const spoken = await speakOrDegrade(reply, sttLanguage, speak);
        return res.json({
          ...fallbackTurn({
            transcript: "",
            reply,
            degraded: mergeDegraded("stt_empty:no speech detected", spoken.degraded),
          }),
          transcript: "",
          audio: spoken.audio,
          languageCode: sttLanguage,
        });
      }

      if (transcript.length > MAX_TEXT_CHARS) {
        // Defensive: a very long dictation would blow the prompt budget downstream.
        transcript = transcript.slice(0, MAX_TEXT_CHARS);
        degraded = mergeDegraded(degraded, "transcript_truncated:2000 chars");
      }
    }

    // ---- 2..5. INTENT -> CONTEXT -> PLAN -> RESPONSE (the orchestrator owns this) ----
    let turn;
    try {
      turn = normalizeTurn(
        await runTurn({
          userId,
          text: transcript,
          languageCode: sttLanguage,
          context: context && typeof context === "object" ? context : {},
          confirm: typeof confirm === "boolean" ? confirm : null,
        }),
        { transcript }
      );
    } catch (err) {
      console.error("[assistant] orchestrator.runTurn failed:", err.message);
      turn = fallbackTurn({
        transcript,
        reply: phrase(sttLanguage, "thinkingFailed"),
        error: `orchestrator failed: ${err.message}`,
        degraded: `orchestrator_failed:${err.message}`,
      });
    }

    // Our transcript is authoritative when we are the one who produced it from audio.
    turn.transcript = turn.transcript ?? transcript;
    turn.degraded = mergeDegraded(turn.degraded, degraded);

    // ---- 6. SPEAK ----
    const spoken = await speakOrDegrade(turn.reply, sttLanguage, speak);
    turn.degraded = mergeDegraded(turn.degraded, spoken.degraded);

    return res.json({
      ...turn,
      transcript: turn.transcript,
      audio: spoken.audio,
      languageCode: sttLanguage,
    });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/assistant/confirm — "yes, do it" / "no, cancel"
 * ------------------------------------------------------------------ */

router.post(
  "/confirm",
  validateBody({
    userId: { type: "string", required: true, max: 128 },
    planId: { type: "string", max: 128 },
    confirm: { type: "boolean", required: true },
    languageCode: { type: "string", max: 16 },
    speak: { type: "boolean" },
  }),
  asyncHandler(async (req, res) => {
    const { userId, planId = null, confirm, speak = true } = req.body || {};
    const languageCode = normalizeLanguage(req.body?.languageCode);

    /* ---------------- Cancellation ---------------- */
    if (confirm === false) {
      // Tell the orchestrator to drop the pending plan, best-effort: even if that
      // bookkeeping fails the user must still hear a clean cancellation.
      let degraded = null;
      try {
        await runTurn({
          userId,
          text: "",
          languageCode,
          context: { planId, confirmationResponse: "cancel" },
          confirm: false,
        });
      } catch (err) {
        console.error("[assistant] cancel bookkeeping failed:", err.message);
        degraded = `orchestrator_failed:${err.message}`;
      }

      const reply = phrase(languageCode, "cancelled");
      try {
        await conversations.append(userId, {
          role: "assistant",
          kind: "cancellation",
          text: reply,
          intent: "cancelled",
          planId,
          at: new Date().toISOString(),
        });
      } catch (err) {
        console.error("[assistant] conversation append failed:", err.message);
        degraded = mergeDegraded(degraded, `store_unavailable:${err.message}`);
      }

      const spoken = await speakOrDegrade(reply, languageCode, speak);
      return res.json({
        ...fallbackTurn({ reply, degraded: mergeDegraded(degraded, spoken.degraded) }),
        confirmed: false,
        planId,
        cancelled: true,
        audio: spoken.audio,
        languageCode,
      });
    }

    /* ---------------- Go-ahead ---------------- */
    let turn;
    try {
      turn = normalizeTurn(
        await runTurn({
          userId,
          text: "",
          languageCode,
          context: { planId, confirmationResponse: "confirm" },
          confirm: true,
        })
      );
    } catch (err) {
      console.error("[assistant] confirm runTurn failed:", err.message);
      turn = fallbackTurn({
        reply: phrase(languageCode, "thinkingFailed"),
        error: `orchestrator failed: ${err.message}`,
        degraded: `orchestrator_failed:${err.message}`,
      });
    }

    // Honesty: confirming only releases the plan to the phone. Nothing has run yet, so
    // when the orchestrator gives us no words we supply a "sending it" line, never a
    // "done" line. Only the phone can say done, via POST /report.
    if (!turn.reply || !String(turn.reply).trim()) {
      turn.reply = phrase(languageCode, "sending");
    }

    const spoken = await speakOrDegrade(turn.reply, languageCode, speak);
    turn.degraded = mergeDegraded(turn.degraded, spoken.degraded);

    return res.json({
      ...turn,
      confirmed: true,
      planId,
      cancelled: false,
      audio: spoken.audio,
      languageCode,
    });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/assistant/report — the client tells us what it ACTUALLY did
 * ------------------------------------------------------------------ *
 * This endpoint is the entire basis for ULTRON being allowed to say that something
 * happened. Nothing else in the backend may claim success.
 */

router.post(
  "/report",
  validateBody({
    userId: { type: "string", required: true, max: 128 },
    actionId: { type: "string", required: true, max: 128 },
    intent: { type: "string", required: true, max: 64 },
    status: { type: "string", required: true, enum: ["done", "failed"] },
    detail: { type: "string" },
    languageCode: { type: "string", max: 16 },
    speak: { type: "boolean" },
  }),
  asyncHandler(async (req, res) => {
    const { userId, actionId, intent, status, detail = null, speak = true } = req.body || {};
    const languageCode = normalizeLanguage(req.body?.languageCode);

    // Belt and braces: validateBody should have caught this, but this one field decides
    // whether we are allowed to say "done", so it gets checked twice.
    if (status !== "done" && status !== "failed") {
      return res.status(400).json({
        error: "bad_request",
        message: '`status` must be exactly "done" or "failed".',
      });
    }

    if (typeof detail === "string" && detail.length > MAX_TEXT_CHARS) {
      return payloadTooLarge(res, "detail", detail.length, MAX_TEXT_CHARS, "Trim the detail text.");
    }

    let known = null;
    try {
      known = typeof getIntent === "function" ? getIntent(intent) : null;
    } catch {
      known = null;
    }
    const label = intentLabel(intent);
    const isHindi = languageCode.toLowerCase().startsWith("hi");
    let degraded = null;

    // Build the acknowledgement from what the CLIENT reported, never from what we planned.
    let reply;
    if (status === "done") {
      reply = isHindi
        ? phrase(languageCode, "reportDone")
        : `${phrase(languageCode, "reportDone")} ${label} completed on your phone.`;
    } else {
      const because = detail ? ` ${detail}` : "";
      reply = isHindi
        ? `${phrase(languageCode, "reportFailed")}${because}`
        : `${phrase(languageCode, "reportFailed")}${because} Want me to try again?`;
    }

    // ---- Persist the real outcome so later turns can reason over it truthfully ----
    let recorded = false;
    try {
      await conversations.append(userId, {
        role: "system",
        kind: "action_report",
        text: `Client reported action "${intent}" (${actionId}) as ${status}${
          detail ? `: ${detail}` : ""
        }`,
        intent,
        actionId,
        status,
        detail,
        at: new Date().toISOString(),
      });
      recorded = true;
    } catch (err) {
      console.error("[assistant] conversation append failed:", err.message);
      degraded = mergeDegraded(degraded, `store_unavailable:${err.message}`);
    }

    // Safety-relevant outcomes get their own audit trail. A failed emergency call is the
    // single most important thing this backend can record.
    const isSafetyCritical =
      intent === "call_emergency" || intent === "safety_mode" || known?.riskLevel === "high";
    if (isSafetyCritical) {
      try {
        await safety.addEvent(userId, {
          type: "action_report",
          intent,
          actionId,
          status,
          detail,
          severity: status === "failed" ? "high" : "info",
          at: new Date().toISOString(),
        });
      } catch (err) {
        console.error("[assistant] safety.addEvent failed:", err.message);
        degraded = mergeDegraded(degraded, `safety_log_unavailable:${err.message}`);
      }
    }

    const spoken = await speakOrDegrade(reply, languageCode, speak);
    degraded = mergeDegraded(degraded, spoken.degraded);

    return res.json({
      ok: true,
      userId,
      actionId,
      intent,
      knownIntent: Boolean(known),
      status,
      detail,
      recorded, // false means we spoke the acknowledgement but could not persist it
      safetyLogged: isSafetyCritical,
      reply,
      audio: spoken.audio,
      languageCode,
      degraded,
    });
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/assistant/reset — forget the session
 * ------------------------------------------------------------------ */

router.post(
  "/reset",
  validateBody({
    userId: { type: "string", required: true, max: 128 },
    languageCode: { type: "string", max: 16 },
    speak: { type: "boolean" },
  }),
  asyncHandler(async (req, res) => {
    const { userId, speak = false } = req.body || {};
    const languageCode = normalizeLanguage(req.body?.languageCode);

    let degraded = null;

    // In-memory Gemini session (prompt history).
    let sessionCleared = false;
    try {
      resetSession(userId);
      sessionCleared = true;
    } catch (err) {
      console.error("[assistant] resetSession failed:", err.message);
      degraded = mergeDegraded(degraded, `session_reset_failed:${err.message}`);
    }

    // Persisted conversation turns. Long-term memories (memories.*) are deliberately NOT
    // touched: "reset" clears the chat, not the facts the user asked ULTRON to remember.
    let conversationCleared = false;
    try {
      await conversations.clear(userId);
      conversationCleared = true;
    } catch (err) {
      console.error("[assistant] conversations.clear failed:", err.message);
      degraded = mergeDegraded(degraded, `store_unavailable:${err.message}`);
    }

    const reply = phrase(languageCode, "reset");
    const spoken = await speakOrDegrade(reply, languageCode, speak);
    degraded = mergeDegraded(degraded, spoken.degraded);

    return res.json({
      ok: sessionCleared || conversationCleared,
      userId,
      cleared: { session: sessionCleared, conversation: conversationCleared },
      memoriesKept: true,
      reply,
      audio: spoken.audio,
      languageCode,
      degraded,
    });
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/assistant/intents — the shared contract, served from one place
 * ------------------------------------------------------------------ *
 * The app renders "what ULTRON can do" from this, which is also how the two sides are
 * kept from drifting apart.
 */

router.get(
  "/intents",
  asyncHandler(async (req, res) => {
    const registry = INTENT_REGISTRY && typeof INTENT_REGISTRY === "object" ? INTENT_REGISTRY : {};
    const names = Array.isArray(INTENT_NAMES) ? INTENT_NAMES : Object.keys(registry);

    // Cheap drift alarm: if the registry and the name list disagree, say so out loud
    // rather than letting the app silently render a half-list.
    const missingFromRegistry = names.filter((n) => !registry[n]);
    const missingFromNames = Object.keys(registry).filter((n) => !names.includes(n));

    const byPhase = {};
    for (const [name, intent] of Object.entries(registry)) {
      const phase = intent?.phase ?? 0;
      (byPhase[phase] ||= []).push(name);
    }

    return res.json({
      count: Object.keys(registry).length,
      names,
      permissions: PERMISSION_KEYS,
      intents: registry,
      byPhase,
      drift:
        missingFromRegistry.length || missingFromNames.length
          ? { missingFromRegistry, missingFromNames }
          : null,
      // Honesty: capabilities the product talks about but the backend does not do yet.
      // Listed explicitly so the app never advertises them as working.
      plannedCapabilities: [
        {
          id: "environmental_sound_classification",
          label: "Horn / siren detection",
          status: "planned",
          note: "Not implemented. No audio is classified for horns, sirens or alarms today.",
        },
      ],
      execution: {
        model: "server-plans / client-executes",
        note:
          "Actions returned by /turn are PLANS. The server never performs a device action " +
          "and never reports one as done until the client calls POST /report.",
      },
    });
  })
);

export default router;
