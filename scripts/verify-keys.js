// ---------------------------------------------------------------------------
// ULTRON AIR — verify the upstream API keys
// ---------------------------------------------------------------------------
//   npm run verify:keys
//
// Calls Google and Sarvam directly with whatever is in server/.env and reports
// what they say. No project code is involved, so a failure here is always the
// key or the network, never a bug in the app.
//
// This exists because "is a key present" and "does the key work" are different
// questions, and only the second one matters. The server confused them for a
// while: /health reported gemini:true while every call came back 401, so the
// app looked healthy and quietly fell back to canned replies.
//
// Run this BEFORE restarting the server after changing a key. It costs one
// cheap request per provider and turns a guess into an answer.
// ---------------------------------------------------------------------------

import 'dotenv/config';

const TIMEOUT_MS = 15_000;

/** Never print a secret. Enough to tell two keys apart, not enough to use one. */
function fingerprint(key) {
  if (!key) return '(not set)';
  return key.length + ' chars, starts "' + key.slice(0, 4) + '"';
}

async function withTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function report(name, ok, detail, hint) {
  const mark = ok ? 'PASS' : 'FAIL';
  console.log('  [' + mark + '] ' + name);
  if (detail) console.log('         ' + detail);
  if (!ok && hint) console.log('         -> ' + hint);
}

/* ------------------------------------------------------------------ *
 * Gemini
 * ------------------------------------------------------------------ */

async function checkGemini() {
  const key = process.env.GEMINI_API_KEY;
  console.log('\nGemini  ' + fingerprint(key));

  if (!key) {
    report(
      'GEMINI_API_KEY',
      false,
      'Not set in server/.env.',
      'Create one at https://aistudio.google.com/apikey',
    );
    return false;
  }

  // NO SHAPE HEURISTIC HERE, deliberately.
  //
  // This script used to warn that anything not starting "AIza" looked wrong.
  // Google now also issues keys beginning "AQ.A", and the warning fired on a
  // perfectly valid one - sending someone off to replace a working credential.
  // Guessing a vendor's credential format from its past format is exactly the
  // kind of inference that ages badly. Let the API be the judge: it is the only
  // authority on whether its own key works, and it answers in one request.

  try {
    const response = await withTimeout(
      'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key),
    );

    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      const count = Array.isArray(data.models) ? data.models.length : 0;
      report('GEMINI_API_KEY', true, 'Accepted. ' + count + ' models visible.');
      return true;
    }

    const body = await response.text().catch(() => '');
    const reason = response.status === 401 || response.status === 403
      ? 'Google rejected this key.'
      : 'Unexpected HTTP ' + response.status + '.';

    report(
      'GEMINI_API_KEY',
      false,
      reason + ' ' + body.slice(0, 160).replace(/\s+/g, ' '),
      'Create a key at https://aistudio.google.com/apikey and paste the whole value.',
    );
    return false;
  } catch (err) {
    report('GEMINI_API_KEY', false, 'Could not reach Google: ' + (err && err.message));
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Sarvam
 * ------------------------------------------------------------------ */

async function checkSarvam() {
  const key = process.env.SARVAM_API_KEY;
  console.log('\nSarvam  ' + fingerprint(key));

  if (!key) {
    report(
      'SARVAM_API_KEY',
      false,
      'Not set in server/.env.',
      'Create one at https://dashboard.sarvam.ai',
    );
    return false;
  }

  try {
    // Smallest useful call: synthesise one word. Sarvam has no free "list
    // models" endpoint, so this is the cheapest way to prove the key works.
    const response = await withTimeout('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'api-subscription-key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: ['ok'],
        target_language_code: 'hi-IN',
        // Must stay in step with services/sarvam.js. Both were 'meera' on
        // 'bulbul:v2' until Sarvam deprecated that model.
        speaker: 'priya',
        model: 'bulbul:v3',
      }),
    });

    if (response.ok) {
      report('SARVAM_API_KEY', true, 'Accepted. Text-to-speech responded.');
      return true;
    }

    const body = await response.text().catch(() => '');
    const detail = body.slice(0, 200).replace(/\s+/g, ' ');

    // A 400 is the request body being wrong, which means the key ALREADY
    // authenticated - the call got far enough to be validated. Reporting that
    // as a bad key sends you to the dashboard to replace a working credential.
    // This script did exactly that once, which is why the distinction is here.
    if (response.status === 400) {
      report(
        'SARVAM_API_KEY',
        true,
        'Key accepted. The request itself was rejected: ' + detail,
        undefined,
      );
      console.log('         -> The KEY is fine. Fix the request in');
      console.log('            server/src/services/sarvam.js (model or speaker),');
      console.log('            not the credential.');
      return true;
    }

    report(
      'SARVAM_API_KEY',
      false,
      'Sarvam returned HTTP ' + response.status + '. ' + detail,
      'Check the key at https://dashboard.sarvam.ai, and that the account has credit.',
    );
    return false;
  } catch (err) {
    report('SARVAM_API_KEY', false, 'Could not reach Sarvam: ' + (err && err.message));
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Access token (local config, not an upstream call)
 * ------------------------------------------------------------------ */

function checkAccessToken() {
  const token = (process.env.API_ACCESS_TOKEN || '').trim();
  console.log('\nAccess token');

  if (!token) {
    report(
      'API_ACCESS_TOKEN',
      false,
      'Not set. The server runs OPEN in development and refuses to start in production.',
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
    return false;
  }

  if (token.length < 24) {
    report('API_ACCESS_TOKEN', false, 'Set but short (' + token.length + ' chars).', 'Use 32 random bytes.');
    return false;
  }

  report('API_ACCESS_TOKEN', true, 'Set, ' + token.length + ' chars.');
  console.log('         Must match EXPO_PUBLIC_API_TOKEN in mobile/.env.');
  return true;
}

/* ------------------------------------------------------------------ */

console.log('ULTRON AIR — checking credentials in server/.env');

// Sequential, not Promise.all: these write interleaved section headers to the
// same console, and a readable report matters more than saving three seconds.
const geminiOk = await checkGemini();
const sarvamOk = await checkSarvam();
const tokenOk = checkAccessToken();

const upstreamOk = geminiOk && sarvamOk;

console.log('');
if (upstreamOk) {
  console.log('Both AI providers accepted their keys. Restart the server and the assistant will answer.');
} else {
  console.log('The assistant will fall back to canned replies until the failing keys above are replaced.');
  console.log('The app still runs; it just cannot reach a model.');
}

// `process.exitCode` rather than `process.exit()`. Exiting hard while fetch's
// abort timers are still unwinding trips a libuv assertion on Windows, which
// prints an alarming crash after an otherwise successful run. Setting the code
// lets Node drain its handles and exit cleanly on its own.
process.exitCode = upstreamOk && tokenOk ? 0 : 1;
