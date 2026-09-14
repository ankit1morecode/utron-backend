// vision.js — ULTRON AIR's camera understanding.
//
//   POST /api/vision       one still frame + a task -> one spoken-length answer
//   GET  /api/vision/tasks the task catalogue, with honest status per task
//
// WHY THIS ROUTE EXISTS AT ALL
// ----------------------------
// The accessibility features in the spec — "read this sign aloud", "what is in
// front of me" — were filed under future work needing an on-device vision
// model. They do not. Gemini is multimodal, the app already has expo-camera and
// the camera permission, so the whole feature is this file plus a screen.
//
// WHAT IT DOES NOT DO, AND MUST NEVER CLAIM TO
// --------------------------------------------
// This answers a question about ONE photograph, over the network, in about a
// second. It is not continuous, it does not watch anything, and it cannot warn
// a user about something moving towards them. Every task below that touches
// mobility is capped at `partial` and carries that caveat in its own text,
// because a blind user who believes this is watching the road is a user this
// product has endangered. Obstacle and traffic-light tasks stay `planned`: not
// because the model would refuse to answer, but because a one-second-stale
// answer about a moving hazard is worse than no answer.

import { Router } from "express";

import { asyncHandler, validateBody } from "../middleware/index.js";
import {
  describeImage,
  isGeminiConfigured,
  isGeminiUsable,
  geminiCredentialError,
} from "../services/gemini.js";

const router = Router();

/** Mirrors the service's own ceiling so an oversized body 413s before Gemini sees it. */
const MAX_IMAGE_B64_CHARS = 7 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * The task catalogue
 * ------------------------------------------------------------------ *
 * `prompt` is the instruction actually sent. It is written for someone who
 * cannot see the picture, so: concrete nouns, spatial position, no hedging
 * about image quality unless the image really is unusable, and no preamble —
 * the answer is going straight to a text-to-speech engine and into an earbud.
 */
const TASKS = {
  describe_scene: {
    id: "describe_scene",
    title: "Describe what is in front of me",
    status: "partial",
    prompt:
      "Describe this scene for someone who cannot see it. Lead with the most important thing. " +
      "Name objects and people concretely and say roughly where they are (left, centre, right, near, far). " +
      "Two or three short sentences, spoken plainly. No preamble, no mention of the photo or the image itself.",
    note:
      "A description of one photo, taken when you pressed the button. It does not watch continuously and cannot tell you about anything that moves.",
  },

  read_text: {
    id: "read_text",
    title: "Read the text",
    status: "partial",
    prompt:
      "Read every piece of text in this image, out loud, in reading order. " +
      "Reproduce the words exactly — do not summarise, translate, correct spelling or explain them. " +
      "If some text is too blurry or cut off to read, say which part and move on. " +
      "If there is no text at all, say exactly: There is no text I can read here.",
    note:
      "Reads text it can actually see. Small, angled or blurry text may be missed — it will say so rather than guess.",
  },

  identify_object: {
    id: "identify_object",
    title: "What is this?",
    status: "partial",
    prompt:
      "Identify the single main object being held up or pointed at in this image. " +
      "Say what it is in one short sentence. If there is writing on it that identifies it — a brand, a label, a denomination — read that out too. " +
      "If you are not certain what it is, say so plainly instead of guessing.",
    note:
      "Identifies one object at a time. It will say when it is unsure rather than guess.",
  },

  read_sign: {
    id: "read_sign",
    title: "Read the sign",
    status: "partial",
    prompt:
      "Read the sign or board in this image. Give the text exactly as written, then, only if it is genuinely unclear, one short sentence on what kind of sign it is. " +
      "If there is no sign, say exactly: I cannot see a sign here.",
    note:
      "For fixed signs and boards. Not for road signs read while moving — it answers about a single still photo.",
  },

  // Deliberately absent from the served catalogue. See the header: these are
  // the two tasks where a one-second-old answer about a moving hazard is
  // actively dangerous, and the model's willingness to answer is not the test.
  detect_obstacle: {
    id: "detect_obstacle",
    title: "Warn me about obstacles",
    status: "planned",
    prompt: null,
    note:
      "Not built. Obstacle warning needs a continuous on-device model. A photo answered a second ago cannot be trusted for something moving towards you, so ULTRON will not pretend to do it.",
  },

  traffic_light: {
    id: "traffic_light",
    title: "Is the light green?",
    status: "planned",
    prompt: null,
    note:
      "Not built, and deliberately so. Crossing a road on a one-second-old answer from a network call is not safe, and ULTRON will not answer a question whose wrong answer is that costly.",
  },
};

function geminiUnavailable(res, what) {
  const detail = geminiCredentialError();
  return res.status(503).json({
    error: "gemini_unavailable",
    code: "gemini_unavailable",
    message:
      `ULTRON cannot ${what} right now: ` +
      (detail || "the AI service is not configured on this server."),
    hint: "Vision needs GEMINI_API_KEY set on the server. Nothing on the phone can fix this.",
  });
}

/* ------------------------------------------------------------------ *
 * GET /api/vision/tasks
 * ------------------------------------------------------------------ *
 * Served even without a key, so the app can render the screen and label it
 * honestly before anyone presses anything.
 */
router.get("/tasks", (req, res) => {
  res.json({
    configured: isGeminiConfigured(),
    usable: isGeminiUsable(),
    tasks: Object.values(TASKS).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      note: task.note,
      // Whether this route will actually attempt it.
      available: task.prompt !== null,
    })),
  });
});

/* ------------------------------------------------------------------ *
 * POST /api/vision
 * ------------------------------------------------------------------ */

router.post(
  "/",
  // Size guard before validateBody, so an oversized frame gets 413 not 400.
  (req, res, next) => {
    const image = req.body?.imageBase64;
    if (typeof image === "string" && image.length > MAX_IMAGE_B64_CHARS) {
      return res.status(413).json({
        error: "payload_too_large",
        code: "bad_request",
        message: `imageBase64 is ${image.length} characters; the limit is ${MAX_IMAGE_B64_CHARS}.`,
        hint: "Capture at a lower resolution or raise the compression before sending.",
      });
    }
    return next();
  },
  validateBody({
    imageBase64: { type: "string", required: true },
    task: { type: "string", max: 32 },
    mimeType: { type: "string", max: 64 },
    question: { type: "string", max: 400 },
    userId: { type: "string", max: 128 },
  }),
  asyncHandler(async (req, res) => {
    const { imageBase64, mimeType, question } = req.body || {};
    const taskId = String(req.body?.task || "describe_scene");

    if (!String(imageBase64).trim()) {
      return res.status(400).json({
        error: "bad_request",
        code: "bad_request",
        message: "`imageBase64` must not be empty.",
      });
    }

    const task = TASKS[taskId];
    if (!task) {
      return res.status(400).json({
        error: "bad_request",
        code: "bad_request",
        message: `Unknown task "${taskId}".`,
        hint: `Known tasks: ${Object.keys(TASKS).join(", ")}. See GET /api/vision/tasks.`,
      });
    }

    // A refusal by design, not a failure. 501 rather than 400 so the client can
    // tell "you asked wrongly" from "we will not do this".
    if (task.prompt === null) {
      return res.status(501).json({
        error: "not_implemented",
        code: "not_implemented",
        task: task.id,
        status: task.status,
        message: task.note,
      });
    }

    if (!isGeminiConfigured()) return geminiUnavailable(res, "look at that");

    /*
     * A free-text question is appended, never substituted. The task prompt
     * carries the rules that keep the answer usable and honest — no preamble,
     * say when you are unsure — and letting a caller replace it would let the
     * phone talk the model out of them.
     */
    const prompt =
      typeof question === "string" && question.trim()
        ? `${task.prompt}\n\nThe user also asks: ${question.trim()}`
        : task.prompt;

    try {
      const answer = await describeImage(imageBase64, prompt, {
        mimeType: mimeType || "image/jpeg",
      });

      return res.json({
        ok: true,
        task: task.id,
        status: task.status,
        answer,
        note: task.note,
        degraded: null,
      });
    } catch (err) {
      console.error("[vision] Gemini vision failed:", err.message);
      // Degrade rather than 500: the phone should say something useful and
      // offer the fallback, not show a crash.
      return res.json({
        ok: false,
        task: task.id,
        status: task.status,
        answer: null,
        degraded: `vision_failed:${err.message}`,
        error: `Gemini vision failed: ${err.message}`,
        hint: "Tell the user ULTRON could not see the picture this time, and to try again.",
      });
    }
  })
);

export default router;
