// ULTRON AIR — speech route.
//
// Thin, honest HTTP surface over Sarvam AI for the two raw speech primitives the app
// needs outside the assistant loop:
//   * /tts    — text in, base64 audio out (used for canned prompts, re-speak, previews)
//   * /stt    — base64 audio in, transcript out (used by the push-to-talk screen)
//   * /voices — what the app is allowed to offer the user, with an honest status per language
//
// Design rules that matter here:
//   * A missing SARVAM_API_KEY is a 503 naming the env var, not a mystery 500.
//   * An upstream failure degrades: /tts hands the text back with audio:null so the app
//     can fall back to on-device synthesis; /stt hands back transcript:null so the app
//     can ask the user to repeat. Neither ever throws a 500 at the earbuds.

import { Router } from "express";

import { asyncHandler, validateBody } from "../middleware/index.js";
import {
  textToSpeech,
  speechToText,
  isSarvamConfigured,
  ttsModel,
  sttModel,
  ttsSpeaker,
} from "../services/sarvam.js";

const router = Router();

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

const MAX_TEXT_CHARS = 2000;
const MAX_AUDIO_B64_CHARS = 8 * 1024 * 1024; // ~8MB of base64

// NOTE: src/index.js parses JSON with a 2mb limit. body-parser skips an already-parsed
// body, so a router-level parser with a larger limit would have no effect — the ceiling
// for /stt uploads has to be raised in index.js. The check below is the second gate.

// The model IDs come from services/sarvam.js, which reads them from the
// environment. They used to be duplicated here as literals, which meant this
// route could report one model while the service actually called another —
// and that is exactly the kind of drift that made two deprecations (bulbul:v2,
// saarika:v2) hard to see. One source of truth instead.

/* ------------------------------------------------------------------ *
 * Language + voice catalogue
 * ------------------------------------------------------------------ *
 * status is a promise to the user, so it is deliberately conservative:
 *   'live'    — exercised end to end in this product, we stand behind it
 *   'partial' — the same Sarvam pipeline and the same code path, but not validated
 *               by us. It may work well; we have not checked, so we do not claim it.
 */
const LANGUAGES = [
  { code: "hi-IN", name: "Hindi", nativeName: "हिन्दी", status: "live" },
  { code: "en-IN", name: "English (India)", nativeName: "English", status: "live" },
  { code: "bn-IN", name: "Bengali", nativeName: "বাংলা", status: "partial" },
  { code: "gu-IN", name: "Gujarati", nativeName: "ગુજરાતી", status: "partial" },
  { code: "kn-IN", name: "Kannada", nativeName: "ಕನ್ನಡ", status: "partial" },
  { code: "ml-IN", name: "Malayalam", nativeName: "മലയാളം", status: "partial" },
  { code: "mr-IN", name: "Marathi", nativeName: "मराठी", status: "partial" },
  { code: "od-IN", name: "Odia", nativeName: "ଓଡ଼ିଆ", status: "partial" },
  { code: "pa-IN", name: "Punjabi", nativeName: "ਪੰਜਾਬੀ", status: "partial" },
  { code: "ta-IN", name: "Tamil", nativeName: "தமிழ்", status: "partial" },
  { code: "te-IN", name: "Telugu", nativeName: "తెలుగు", status: "partial" },
];

const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code));

// The default speaker is the only one this backend has actually been run with; the rest
// are passed through to Sarvam untouched and are flagged unvalidated for that reason.
// Sourced from the service so an env override moves both together.

// The speaker list for bulbul:v3, as reported by Sarvam itself when sent an
// invalid speaker. `validated: true` means a real request with that speaker
// returned audio from this machine, not that it appears in the vendor's list.
//
// Gender is deliberately NOT recorded. The vendor does not publish it, and
// guessing it from a name is exactly the kind of inference that gets a product
// in trouble. If a picker needs to group voices, ask Sarvam for that metadata.
const SPEAKERS = [
  { id: "priya", isDefault: true, validated: true },
  { id: "ritu", isDefault: false, validated: true },
  { id: "neha", isDefault: false, validated: true },
  { id: "aditya", isDefault: false, validated: false },
  { id: "ashutosh", isDefault: false, validated: false },
  { id: "rahul", isDefault: false, validated: false },
  { id: "pooja", isDefault: false, validated: false },
  { id: "rohan", isDefault: false, validated: false },
  { id: "simran", isDefault: false, validated: false },
  { id: "kavya", isDefault: false, validated: false },
  { id: "amit", isDefault: false, validated: false },
  { id: "dev", isDefault: false, validated: false },
];

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function payloadTooLarge(res, field, actual, limit, hint) {
  return res.status(413).json({
    error: "payload_too_large",
    field,
    limit,
    actual,
    message: `"${field}" is ${actual} units, limit is ${limit}. ${hint}`,
  });
}

/** Accept "hi" or "hi-IN"; always hand Sarvam a full tag. */
function normalizeLanguage(code) {
  if (typeof code !== "string" || !code.trim()) return "hi-IN";
  const raw = code.trim();
  if (raw.includes("-")) return raw;
  return `${raw.toLowerCase()}-IN`;
}

/**
 * Actionable 503 when the provider is not configured. The whole point is that whoever
 * hits this in a demo learns exactly which line of .env is missing.
 */
function sarvamNotConfigured(res, capability) {
  return res.status(503).json({
    error: "speech_unconfigured",
    service: "sarvam",
    capability,
    message:
      `Sarvam ${capability} is unavailable because SARVAM_API_KEY is not set on the server. ` +
      "Add SARVAM_API_KEY=<your key> to server/.env (see server/.env.example) and restart " +
      "the API. The rest of the assistant keeps working without it, in text-only mode.",
    envVar: "SARVAM_API_KEY",
    docs: "https://dashboard.sarvam.ai",
  });
}

/** Warn on an unknown language rather than blocking it — Sarvam adds languages faster than we do. */
function languageWarning(code) {
  if (LANGUAGE_CODES.has(code)) return null;
  return `unknown_language:${code} is not in this server's catalogue; passed through to Sarvam as-is`;
}

/* ------------------------------------------------------------------ *
 * POST /api/speech/tts
 * ------------------------------------------------------------------ */

router.post(
  "/tts",
  // Size guard first so an oversized body gets a 413 rather than validateBody's 400.
  (req, res, next) => {
    const text = req.body?.text;
    if (typeof text === "string" && text.length > MAX_TEXT_CHARS) {
      return payloadTooLarge(
        res,
        "text",
        text.length,
        MAX_TEXT_CHARS,
        "Split the text into shorter utterances and synthesise them in sequence."
      );
    }
    return next();
  },
  validateBody({
    text: { type: "string", required: true },
    languageCode: { type: "string", max: 16 },
    speaker: { type: "string", max: 40 },
    pace: { type: "number" },
  }),
  asyncHandler(async (req, res) => {
    const { text, speaker, pace } = req.body || {};
    const languageCode = normalizeLanguage(req.body?.languageCode);

    if (!String(text).trim()) {
      return res.status(400).json({
        error: "bad_request",
        message: "`text` must not be empty.",
      });
    }

    if (!isSarvamConfigured()) return sarvamNotConfigured(res, "text-to-speech");

    // Sarvam's pace is a multiplier; clamp instead of rejecting so a slider glitch on the
    // phone cannot fail a whole utterance.
    const opts = {};
    if (typeof speaker === "string" && speaker.trim()) opts.speaker = speaker.trim();
    if (typeof pace === "number" && Number.isFinite(pace)) {
      opts.pace = Math.min(3, Math.max(0.3, pace));
    }

    const warning = languageWarning(languageCode);

    try {
      const audio = await textToSpeech(String(text), languageCode, opts);

      if (!audio) {
        // A 200 with no audio: the provider answered but gave us nothing usable. Hand
        // the text back so the client can speak it with on-device TTS.
        return res.json({
          ok: false,
          audio: null,
          text,
          languageCode,
          speaker: opts.speaker || ttsSpeaker(),
          degraded: "tts_empty:sarvam returned no audio",
          warning,
        });
      }

      return res.json({
        ok: true,
        audio,
        languageCode,
        speaker: opts.speaker || ttsSpeaker(),
        model: ttsModel(),
        encoding: "base64",
        degraded: null,
        warning,
      });
    } catch (err) {
      console.error("[speech] Sarvam TTS failed:", err.message);
      // Degrade, do not 500: text plus audio:null is a working fallback path on the phone.
      return res.json({
        ok: false,
        audio: null,
        text,
        languageCode,
        speaker: opts.speaker || ttsSpeaker(),
        degraded: `tts_failed:${err.message}`,
        error: `Sarvam text-to-speech failed: ${err.message}`,
        hint: "Speak this text with the device's own TTS engine.",
        warning,
      });
    }
  })
);

/* ------------------------------------------------------------------ *
 * POST /api/speech/stt
 * ------------------------------------------------------------------ */

router.post(
  "/stt",
  (req, res, next) => {
    const audio = req.body?.audioBase64;
    if (typeof audio === "string" && audio.length > MAX_AUDIO_B64_CHARS) {
      return payloadTooLarge(
        res,
        "audioBase64",
        audio.length,
        MAX_AUDIO_B64_CHARS,
        "Record a shorter clip (about 8MB of base64 at most) or send it in chunks."
      );
    }
    return next();
  },
  validateBody({
    audioBase64: { type: "string", required: true },
    languageCode: { type: "string", max: 16 },
    // Sarvam STT defaults to audio/wav, but expo-av records .m4a on Android — the client
    // must be able to declare what it actually recorded or every transcription fails.
    mimeType: { type: "string", max: 64 },
    fileName: { type: "string", max: 128 },
  }),
  asyncHandler(async (req, res) => {
    const { audioBase64, mimeType, fileName } = req.body || {};
    const languageCode = normalizeLanguage(req.body?.languageCode);

    if (!String(audioBase64).trim()) {
      return res.status(400).json({
        error: "bad_request",
        message: "`audioBase64` must not be empty.",
      });
    }

    if (!isSarvamConfigured()) return sarvamNotConfigured(res, "speech-to-text");

    const warning = languageWarning(languageCode);

    const sttOpts = {};
    if (mimeType) sttOpts.mimeType = mimeType;
    if (fileName) sttOpts.fileName = fileName;

    try {
      const result = await speechToText(String(audioBase64), languageCode, sttOpts);
      const transcript = typeof result?.transcript === "string" ? result.transcript : "";

      return res.json({
        ok: true,
        // "" is a real answer (silence). null, below, means we never got one.
        transcript,
        model: sttModel(),
        languageCode: normalizeLanguage(result?.languageCode || languageCode),
        empty: transcript.trim().length === 0,
        degraded: null,
        warning,
      });
    } catch (err) {
      console.error("[speech] Sarvam STT failed:", err.message);
      // transcript:null is deliberately distinct from "": the client must be able to tell
      // "recognition is down" from "you said nothing", and prompt accordingly.
      return res.json({
        ok: false,
        transcript: null,
        model: sttModel(),
        languageCode,
        degraded: `stt_failed:${err.message}`,
        error: `Sarvam speech-to-text failed: ${err.message}`,
        hint: "Ask the user to repeat, or fall back to the device's own recogniser.",
        warning,
      });
    }
  })
);

/* ------------------------------------------------------------------ *
 * GET /api/speech/voices
 * ------------------------------------------------------------------ *
 * Static catalogue, so it answers even without a key — the app needs it to render the
 * language picker before onboarding finishes. `configured:false` plus the same actionable
 * SARVAM_API_KEY message carries the 503's information without hiding the catalogue.
 */

router.get(
  "/voices",
  asyncHandler(async (req, res) => {
    const configured = isSarvamConfigured();

    return res.json({
      configured,
      provider: "sarvam",
      model: ttsModel(),
      sttModel: sttModel(),
      defaultLanguage: "hi-IN",
      defaultSpeaker: ttsSpeaker(),
      languages: LANGUAGES,
      speakers: SPEAKERS,
      statusLegend: {
        live: "Validated end to end in ULTRON AIR.",
        partial:
          "Runs through the same Sarvam pipeline and the same code path, but has not been " +
          "validated by us. Offer it, do not promise it.",
      },
      limits: {
        maxTextChars: MAX_TEXT_CHARS,
        maxAudioBase64Chars: MAX_AUDIO_B64_CHARS,
        paceRange: [0.3, 3],
      },
      notes: [
        "Only the default speaker has been exercised by this backend; other speaker ids are " +
          "passed straight through to Sarvam and are marked validated:false.",
        "Language codes outside this catalogue are not rejected — they are forwarded to " +
          "Sarvam and the response carries a `warning` field.",
      ],
      warning: configured
        ? null
        : "SARVAM_API_KEY is not set on the server, so /api/speech/tts and /api/speech/stt " +
          "will answer 503. Add SARVAM_API_KEY=<your key> to server/.env and restart the API.",
    });
  })
);

export default router;
