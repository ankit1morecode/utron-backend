/**
 * ULTRON AIR — translation routes.
 *
 *   POST /                → one-shot translation (+ optional spoken audio)
 *   POST /conversation    → two-person live interpreter mode (side A <-> side B)
 *   GET  /languages       → supported languages with an HONEST per-language status
 *
 * Two external services are involved and either can be down:
 *   - Gemini produces the translation text.
 *   - Sarvam speaks it in the TARGET language.
 *
 * Degradation ladder (never a 500):
 *   translation fails  → echo the original with `translated: false` + `degraded`,
 *                        so the UI can show "couldn't translate" instead of silently
 *                        presenting untranslated text as a translation.
 *   TTS fails          → `audio: null` + `degraded`; the text still goes out.
 */

import { Router } from "express";
import {
  translateText,
  generateStructured,
  isGeminiConfigured,
} from "../services/gemini.js";
import { textToSpeech, isSarvamConfigured } from "../services/sarvam.js";
import { asyncHandler, validateBody } from "../middleware/index.js";

const router = Router();

const wrap =
  typeof asyncHandler === "function"
    ? asyncHandler
    : (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function body(rules) {
  const mw = typeof validateBody === "function" ? validateBody(rules) : null;
  return typeof mw === "function" ? mw : (req, res, next) => next();
}

const MAX_TEXT = 2000;

/* ------------------------------------------------------------------ *
 * Supported languages
 * ------------------------------------------------------------------ *
 * `tts` / `stt` reflect the SPEECH VENDOR'S DOCUMENTED model coverage (Sarvam
 * bulbul:v2 for TTS, saarika for STT). They are not a quality claim: we have not
 * per-language QA'd accent handling or code-mixing. `translation: "llm"` means the
 * text comes out of a general-purpose model — usable, not certified.
 */
const LANGUAGES = [
  { code: "hi-IN", name: "Hindi", nativeName: "हिन्दी", tts: true, stt: true },
  { code: "en-IN", name: "English (India)", nativeName: "English", tts: true, stt: true },
  { code: "bn-IN", name: "Bengali", nativeName: "বাংলা", tts: true, stt: true },
  { code: "gu-IN", name: "Gujarati", nativeName: "ગુજરાતી", tts: true, stt: true },
  { code: "kn-IN", name: "Kannada", nativeName: "ಕನ್ನಡ", tts: true, stt: true },
  { code: "ml-IN", name: "Malayalam", nativeName: "മലയാളം", tts: true, stt: true },
  { code: "mr-IN", name: "Marathi", nativeName: "मराठी", tts: true, stt: true },
  { code: "od-IN", name: "Odia", nativeName: "ଓଡ଼ିଆ", tts: true, stt: true },
  { code: "pa-IN", name: "Punjabi", nativeName: "ਪੰਜਾਬੀ", tts: true, stt: true },
  { code: "ta-IN", name: "Tamil", nativeName: "தமிழ்", tts: true, stt: true },
  { code: "te-IN", name: "Telugu", nativeName: "తెలుగు", tts: true, stt: true },
  // Text-only today: the model will translate them, the speech vendor will not speak
  // them. Listing them as fully supported would be a lie the user hears immediately.
  { code: "ur-IN", name: "Urdu", nativeName: "اردو", tts: false, stt: false },
  { code: "as-IN", name: "Assamese", nativeName: "অসমীয়া", tts: false, stt: false },
  { code: "mai-IN", name: "Maithili", nativeName: "मैथिली", tts: false, stt: false },
  { code: "sa-IN", name: "Sanskrit", nativeName: "संस्कृतम्", tts: false, stt: false },
];

const LANG_BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

function languageNameFor(code, fallback) {
  return LANG_BY_CODE.get(code)?.name || fallback || code;
}

function ttsSupported(code) {
  const entry = LANG_BY_CODE.get(code);
  return entry ? entry.tts : true; // unknown code: let the vendor decide, then degrade
}

/* ------------------------------------------------------------------ *
 * Speech helper — TTS is always best-effort
 * ------------------------------------------------------------------ */
async function speak(text, languageCode) {
  if (!text) return { audio: null, degraded: null };

  if (!isSarvamConfigured()) {
    return { audio: null, degraded: "tts-not-configured" };
  }
  if (!ttsSupported(languageCode)) {
    // Do not burn a request (and a timeout) on a language the voice model cannot say.
    return { audio: null, degraded: `tts-unsupported-language:${languageCode}` };
  }

  try {
    const audio = await textToSpeech(text, languageCode);
    return { audio: audio || null, degraded: audio ? null : "tts-empty-response" };
  } catch (err) {
    console.error(`[translate] TTS failed (${languageCode}):`, err.message);
    return { audio: null, degraded: "tts-unavailable" };
  }
}

/* ------------------------------------------------------------------ *
 * Conversation buffer (interpreter mode)
 * ------------------------------------------------------------------ *
 * Short, per-user, in-process and deliberately NOT the assistant's conversation
 * store: interpreter turns are raw speech from two different people and would poison
 * the chat history the orchestrator reasons over. It exists only so that follow-up
 * lines ("and the other one?") carry their referent across turns.
 */
const conversationBuffers = new Map(); // userId -> { turns: [], updatedAt }
const CONV_MAX_TURNS = 8;
const CONV_TTL_MS = 15 * 60 * 1000;
const CONV_MAX_USERS = 200;

function sweepBuffers() {
  const now = Date.now();
  for (const [key, buf] of conversationBuffers) {
    if (now - buf.updatedAt > CONV_TTL_MS) conversationBuffers.delete(key);
  }
  // Hard cap after the TTL sweep: drop the least recently used (insertion order).
  while (conversationBuffers.size > CONV_MAX_USERS) {
    const oldest = conversationBuffers.keys().next().value;
    conversationBuffers.delete(oldest);
  }
}

function getBuffer(userId) {
  const buf = conversationBuffers.get(userId);
  if (!buf) return [];
  if (Date.now() - buf.updatedAt > CONV_TTL_MS) {
    conversationBuffers.delete(userId);
    return [];
  }
  return buf.turns;
}

function pushTurn(userId, turn) {
  const turns = getBuffer(userId).concat(turn).slice(-CONV_MAX_TURNS);
  conversationBuffers.delete(userId); // re-insert to keep LRU ordering honest
  conversationBuffers.set(userId, { turns, updatedAt: Date.now() });
  if (conversationBuffers.size > CONV_MAX_USERS) sweepBuffers();
  return turns;
}

function renderContext(turns) {
  if (!turns.length) return "";
  return turns
    .slice(-4)
    .map(
      (t) =>
        `Speaker ${t.side.toUpperCase()} (${t.sourceLanguage}): ${t.text}\n` +
        `  -> rendered in ${t.targetLanguage}: ${t.translation}`
    )
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * Translation core — structured first, plain second, echo last
 * ------------------------------------------------------------------ */
async function translateWithContext({ text, sourceLanguage, targetLanguage, contextBlock }) {
  if (!isGeminiConfigured()) {
    return {
      translation: text,
      translated: false,
      degraded: "translation-not-configured",
      error: "Translation service is not configured on the server.",
      detectedSourceLanguage: sourceLanguage,
    };
  }

  // 1) Structured call: lets the model tell us which language it actually heard,
  //    which matters in interpreter mode where the caller's guess can be wrong.
  if (contextBlock !== undefined && typeof generateStructured === "function") {
    try {
      const result = await generateStructured({
        systemInstruction:
          "You are a live interpreter for a two-person conversation held through " +
          "earbuds. Translate the speaker's line faithfully and colloquially, " +
          "preserving names, numbers and tone. Never answer the speaker, never add " +
          "commentary, never explain — only interpret. Resolve pronouns using the " +
          "conversation so far.",
        prompt:
          (contextBlock ? `Conversation so far:\n${contextBlock}\n\n` : "") +
          `The speaker is talking in ${sourceLanguage}. ` +
          `Render their line into ${targetLanguage}.\n` +
          `Line: ${text}\n\n` +
          'Reply as JSON: { "translation": "...", "detectedSourceLanguage": "..." }',
        schema: {
          type: "object",
          properties: {
            translation: { type: "string" },
            detectedSourceLanguage: { type: "string" },
          },
          required: ["translation"],
        },
      });

      const translation = String(result?.translation ?? "").trim();
      if (translation) {
        return {
          translation,
          translated: true,
          degraded: null,
          error: null,
          detectedSourceLanguage:
            String(result?.detectedSourceLanguage || "").trim() || sourceLanguage,
        };
      }
    } catch (err) {
      console.error("[translate] structured translation failed:", err.message);
      // fall through to the plain call
    }
  }

  // 2) Plain translation call.
  try {
    const translation = (await translateText(text, targetLanguage, sourceLanguage))?.trim();
    if (translation) {
      return {
        translation,
        translated: true,
        degraded: contextBlock !== undefined ? "context-dropped" : null,
        error: null,
        detectedSourceLanguage: sourceLanguage,
      };
    }
    throw new Error("empty translation");
  } catch (err) {
    console.error("[translate] translation failed:", err.message);
    // 3) Echo, clearly flagged. The client must not render this as a translation.
    return {
      translation: text,
      translated: false,
      degraded: "translation-unavailable",
      error: `Translation service failed: ${err.message}`,
      detectedSourceLanguage: sourceLanguage,
    };
  }
}

function mergeDegraded(...values) {
  const list = values.filter(Boolean);
  return list.length ? list.join("; ") : null;
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

// POST /api/translate
// { text, targetLanguage, targetLanguageCode?, sourceLanguage?, speak? }
router.post(
  "/",
  body({
    text: { type: "string", required: true, max: MAX_TEXT },
    targetLanguage: { type: "string", required: true, max: 64 },
  }),
  wrap(async (req, res) => {
    const {
      text,
      targetLanguage,
      targetLanguageCode = "hi-IN",
      sourceLanguage = "auto",
      speak: shouldSpeak = true,
    } = req.body || {};

    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }
    if (text.trim().length > MAX_TEXT) {
      return res
        .status(400)
        .json({ error: `text must be at most ${MAX_TEXT} characters` });
    }
    if (typeof targetLanguage !== "string" || !targetLanguage.trim()) {
      return res.status(400).json({ error: "targetLanguage is required" });
    }

    const result = await translateWithContext({
      text: text.trim(),
      sourceLanguage: typeof sourceLanguage === "string" ? sourceLanguage : "auto",
      targetLanguage: targetLanguage.trim(),
      contextBlock: undefined, // one-shot: no conversation context
    });

    let audio = null;
    let ttsDegraded = null;
    if (shouldSpeak !== false && result.translated) {
      const spoken = await speak(result.translation, targetLanguageCode);
      audio = spoken.audio;
      ttsDegraded = spoken.degraded;
    } else if (shouldSpeak !== false && !result.translated) {
      ttsDegraded = "tts-skipped-no-translation";
    }

    res.json({
      translation: result.translation,
      translated: result.translated,
      audio,
      sourceLanguage: result.detectedSourceLanguage,
      targetLanguage: targetLanguage.trim(),
      targetLanguageCode,
      degraded: mergeDegraded(result.degraded, ttsDegraded),
      error: result.error,
    });
  })
);

// POST /api/translate/conversation — two-person live interpreter mode.
// { userId, text, speakerSide: 'a'|'b', langA, langB, langACode, langBCode }
router.post(
  "/conversation",
  body({
    userId: { type: "string", required: true, max: 128 },
    text: { type: "string", required: true, max: MAX_TEXT },
    speakerSide: { type: "string", required: true, enum: ["a", "b"] },
  }),
  wrap(async (req, res) => {
    const {
      userId,
      text,
      speakerSide,
      langA = "Hindi",
      langB = "English",
      langACode = "hi-IN",
      langBCode = "en-IN",
    } = req.body || {};

    const errors = [];
    if (typeof userId !== "string" || !userId.trim()) errors.push("userId is required");
    if (typeof text !== "string" || !text.trim()) errors.push("text is required");
    else if (text.trim().length > MAX_TEXT)
      errors.push(`text must be at most ${MAX_TEXT} characters`);
    const side = typeof speakerSide === "string" ? speakerSide.toLowerCase() : "";
    if (side !== "a" && side !== "b") errors.push('speakerSide must be "a" or "b"');
    for (const [k, v] of Object.entries({ langA, langB, langACode, langBCode })) {
      if (typeof v !== "string" || !v.trim()) errors.push(`${k} must be a non-empty string`);
    }
    if (errors.length) {
      return res.status(400).json({ error: errors[0], details: errors });
    }

    // Whoever spoke, the translation goes to the OTHER side, in the other side's
    // language, and is spoken with the other side's voice code.
    const spokeA = side === "a";
    const sourceLanguage = spokeA ? langA : langB;
    const targetLanguage = spokeA ? langB : langA;
    const targetLanguageCode = spokeA ? langBCode : langACode;
    const sourceLanguageCode = spokeA ? langACode : langBCode;
    const targetSide = spokeA ? "b" : "a";

    const priorTurns = getBuffer(userId);

    const result = await translateWithContext({
      text: text.trim(),
      sourceLanguage,
      targetLanguage,
      contextBlock: renderContext(priorTurns), // "" on the first turn, still enables
                                               // the structured/interpreter path
    });

    const spoken = result.translated
      ? await speak(result.translation, targetLanguageCode)
      : { audio: null, degraded: "tts-skipped-no-translation" };

    // Only record turns we actually translated; storing echo-fallbacks as if they
    // were interpretations would corrupt the context for every later turn.
    const turns = result.translated
      ? pushTurn(userId, {
          side,
          text: text.trim(),
          translation: result.translation,
          sourceLanguage,
          targetLanguage,
          at: new Date().toISOString(),
        })
      : priorTurns;

    res.json({
      translation: result.translation,
      translated: result.translated,
      audio: spoken.audio,
      speakerSide: side,
      targetSide,
      sourceLanguage: result.detectedSourceLanguage || sourceLanguage,
      sourceLanguageCode,
      targetLanguage,
      targetLanguageCode,
      contextTurns: turns.length,
      degraded: mergeDegraded(result.degraded, spoken.degraded),
      error: result.error,
    });
  })
);

// DELETE /api/translate/conversation/:userId — drop the interpreter buffer
// (end of a conversation, or the user asking for privacy mid-session).
router.delete("/conversation/:userId", (req, res) => {
  const existed = conversationBuffers.delete(req.params.userId);
  res.json({ cleared: true, hadBuffer: existed });
});

// GET /api/translate/languages — supported languages, honestly labelled.
router.get("/languages", (req, res) => {
  const geminiUp = isGeminiConfigured();
  const sarvamUp = isSarvamConfigured();

  const languages = LANGUAGES.map((l) => ({
    code: l.code,
    name: l.name,
    nativeName: l.nativeName,
    // Text translation is LLM-generated for every language on the list.
    translation: geminiUp ? "llm" : "unavailable",
    tts: !l.tts ? "not-supported" : sarvamUp ? "supported" : "unavailable",
    stt: !l.stt ? "not-supported" : sarvamUp ? "supported" : "unavailable",
    // Voice round-trip only works where BOTH speech directions exist.
    voiceConversation: Boolean(l.tts && l.stt && sarvamUp && geminiUp),
  }));

  res.json({
    languages,
    services: {
      translation: geminiUp ? "configured" : "not-configured",
      speech: sarvamUp ? "configured" : "not-configured",
    },
    statusLegend: {
      supported: "The vendor documents support and the API key is configured.",
      unavailable: "Capability exists but the service key is missing or the service is down.",
      "not-supported": "The speech vendor does not offer this language; text only.",
      llm: "Translation is produced by a general-purpose language model.",
    },
    notes: [
      "Translations are model-generated and are not human-reviewed. Do not rely on them for legal, medical or safety-critical wording.",
      "TTS/STT status mirrors the speech vendor's documented model coverage; this project has not per-language QA'd accents, dialects or code-mixed speech.",
      "Hindi<->English is the best-tested pair; other pairs are functional but less exercised.",
      "Live interpreter mode adds network round-trips for both translation and speech, so expect latency rather than true simultaneous interpretation.",
    ],
  });
});

export default router;
