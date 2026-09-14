/**
 * POST /api/chat  -  LEGACY / DEPRECATED.
 *
 * DEPRECATED in favour of POST /api/assistant/turn, which returns the full TurnResult
 * (intent, plan, actions, needsConfirmation, needsPermission, degraded...). This route
 * exists only so the already-shipped mobile screens keep working unchanged during the
 * migration. It is a thin shim: it calls the same orchestrator and then throws away
 * everything except { reply, audio }.
 *
 * Contract kept byte-for-byte with the old implementation:
 *   request : { userId, message, speak?: boolean, languageCode?: string }
 *   response: { reply, audio }          // audio = base64 string or null
 *
 * New clients: use /api/assistant/turn. Do not add fields to the JSON body of this
 * response - older builds parse it strictly. Extra signal is exposed as response HEADERS
 * (X-Ultron-Degraded, X-Ultron-Intent, X-Ultron-Needs-Confirmation).
 */
import { Router } from 'express';

import { runTurn } from '../services/orchestrator.js';
import { textToSpeech } from '../services/sarvam.js';
import { asyncHandler, validateBody } from '../middleware/index.js';

const router = Router();

// Last-resort text when even the orchestrator fails. The assistant must still SAY something.
// Never claim an action was performed here - the phone is what performs actions.
const FALLBACK_REPLY = {
  'hi-IN': 'Main abhi jawab nahi de pa raha hoon. Thodi der baad phir se try kijiye.',
  'en-IN': "I could not process that just now. Please try again in a moment.",
};

function fallbackFor(languageCode) {
  if (FALLBACK_REPLY[languageCode]) return FALLBACK_REPLY[languageCode];
  // Any Indian-language locale gets the Hindi line; everything else gets English.
  if (typeof languageCode === 'string' && languageCode.endsWith('-IN') && !languageCode.startsWith('en')) {
    return FALLBACK_REPLY['hi-IN'];
  }
  return FALLBACK_REPLY['en-IN'];
}

// Older builds send `message`; a couple of dev builds send `text`. Normalise before validating.
function normalizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    if (!req.body.message && typeof req.body.text === 'string') req.body.message = req.body.text;
  }
  next();
}

router.post(
  '/',
  normalizeBody,
  validateBody({
    userId: { type: 'string', required: true, max: 128 },
    message: { type: 'string', required: true, max: 4000 },
    speak: { type: 'boolean' },
    languageCode: { type: 'string', max: 16 },
  }),
  asyncHandler(async (req, res) => {
    const { userId, message, speak = true, languageCode = 'hi-IN' } = req.body;

    let reply;
    let degraded = null;
    let intent = 'unknown';
    let needsConfirmation = false;

    try {
      const turn = await runTurn({
        userId,
        text: message,
        languageCode,
        // This legacy endpoint carries no device context and cannot receive a confirmation,
        // so the orchestrator will plan but nothing can be marked executed. That is correct:
        // the reply may ask for confirmation, it must never say an action was done.
        context: { source: 'legacy-chat' },
        confirm: null,
      });

      reply = (turn && turn.reply) || fallbackFor(languageCode);
      degraded = (turn && turn.degraded) || null;
      intent = (turn && turn.intent) || 'unknown';
      needsConfirmation = Boolean(turn && turn.needsConfirmation);
    } catch (err) {
      // Degrade, never 500: the old app shows a raw error toast on a non-200.
      console.error('[chat:legacy] orchestrator failed: ' + (err && err.message));
      reply = fallbackFor(languageCode);
      degraded = 'orchestrator';
    }

    // TTS is best-effort. If Sarvam is unconfigured or down we return text with audio: null
    // and the app reads it on screen instead of speaking it.
    let audio = null;
    if (speak) {
      try {
        audio = await textToSpeech(reply, languageCode);
      } catch (ttsErr) {
        console.error('[chat:legacy] TTS failed, returning text only: ' + (ttsErr && ttsErr.message));
        degraded = degraded ? degraded + ',tts' : 'tts';
      }
    }

    if (degraded) res.set('X-Ultron-Degraded', String(degraded));
    res.set('X-Ultron-Intent', String(intent));
    res.set('X-Ultron-Needs-Confirmation', needsConfirmation ? '1' : '0');
    res.set('X-Ultron-Deprecated', 'use POST /api/assistant/turn');

    // Exactly the legacy shape - nothing added.
    res.json({ reply, audio });
  })
);

export default router;
