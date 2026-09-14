// ---------------------------------------------------------------------------
// ULTRON AIR — access control and abuse limiting
// ---------------------------------------------------------------------------
// WHAT THIS PROTECTS
// -----------------
// Every /api route spends money. An assistant turn calls Gemini; a spoken reply
// calls Sarvam. Both bill against keys in server/.env. A public URL with no gate
// in front of it is an open tap on someone else's credit card, and the first
// thing that finds it will be an automated scanner, not a user.
//
// It also protects data. `userId` is a plain string the client sends, so without
// a gate anyone can read or overwrite any user's stored memory by guessing one.
//
// WHAT THIS IS NOT
// ----------------
// A shared token shipped inside a mobile app is EXTRACTABLE. Anyone can unzip an
// APK and read it. This is a lock on the front door, not identity: it stops
// drive-by scanners, scrapers and casual abuse, which is the overwhelming
// majority of what a small hosted API actually sees.
//
// It does NOT authenticate users and does NOT stop a determined attacker who has
// the app. The real fix is per-device registration issuing a per-user token, so
// one leaked credential can be revoked without shipping a new build. That is a
// larger piece of work and is deliberately not pretended at here.
//
// Read the two together: the token raises the cost of finding the API, and the
// rate limiter caps the damage from anyone who does.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const PRODUCTION = process.env.NODE_ENV === 'production';

/** Routes reachable with no token. Deliberately tiny. */
const PUBLIC_PATHS = new Set(['/health']);

/**
 * Read the configured token.
 *
 * Returned trimmed, or null when unset. Null has very different consequences
 * in development and production - see `assertSecurityConfig`.
 */
function configuredToken() {
  const raw = process.env.API_ACCESS_TOKEN;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Fail the boot rather than serve an open API in production.
 *
 * Called from index.js before listen(). A server that silently starts without
 * its gate is the exact failure this whole file exists to prevent, so it must
 * be loud and it must be fatal.
 */
export function assertSecurityConfig() {
  const token = configuredToken();

  if (token) {
    if (token.length < 24) {
      console.warn(
        '[security] API_ACCESS_TOKEN is short. Generate a strong one:\n' +
          '           node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    return { enforced: true };
  }

  if (PRODUCTION) {
    console.error(
      '[security] FATAL: API_ACCESS_TOKEN is not set and NODE_ENV=production.\n' +
        '           Refusing to start: this would expose Gemini and Sarvam quota,\n' +
        '           and every user memory, to anyone who finds the URL.\n' +
        '           Generate one with:\n' +
        '             node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
    process.exit(1);
  }

  console.warn(
    '[security] API_ACCESS_TOKEN is not set. Running OPEN for local development.\n' +
      '           This is fine on your LAN. It is not safe to host.\n' +
      '           Set API_ACCESS_TOKEN in server/.env before deploying.',
  );
  return { enforced: false };
}

/* ------------------------------------------------------------------ *
 * Token check
 * ------------------------------------------------------------------ */

/** Pull a bearer token out of the request, accepting either common header. */
function presentedToken(req) {
  const authorization = req.get('authorization');
  if (typeof authorization === 'string') {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }

  const apiKey = req.get('x-api-key');
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) return apiKey.trim();

  return null;
}

/**
 * Constant-time comparison.
 *
 * A plain `===` on a secret leaks its contents through timing: an attacker can
 * recover it one character at a time by measuring how long the comparison
 * takes. `timingSafeEqual` needs equal-length buffers, so both sides are hashed
 * first, which also makes length itself non-observable.
 */
function tokensMatch(presented, expected) {
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Gate every /api route behind the shared token.
 *
 * `/health` stays open on purpose: the mobile app polls it to decide what to
 * show as degraded, and a monitoring check should not need a credential to ask
 * whether the process is alive. It reveals only which integrations are
 * configured, never their keys.
 */
export function requireApiToken(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const expected = configuredToken();

  // Unset and non-production: `assertSecurityConfig` already warned loudly at
  // boot. Staying open here is what keeps local development frictionless.
  if (!expected) return next();

  const presented = presentedToken(req);

  if (!presented) {
    return res.status(401).json({
      error: 'Unauthorized',
      detail: 'This API requires an access token. Send it as "Authorization: Bearer <token>".',
      code: 'MISSING_ACCESS_TOKEN',
    });
  }

  if (!tokensMatch(presented, expected)) {
    // Logged without the presented value: writing a rejected credential into
    // the logs is how the next leak happens.
    console.warn('[security] Rejected a request with an invalid access token from ' + clientKey(req));
    return res.status(401).json({
      error: 'Unauthorized',
      detail: 'That access token is not valid for this server.',
      code: 'INVALID_ACCESS_TOKEN',
    });
  }

  return next();
}

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

/**
 * Per-process, in-memory fixed windows.
 *
 * LIMITATION, stated rather than discovered later: this counts per Node
 * process. Behind a load balancer with several instances the effective limit
 * multiplies by the instance count, and a restart clears every counter. For a
 * single hosted instance it is accurate; for a scaled deployment the counters
 * belong in Redis.
 *
 * Chosen over `express-rate-limit` only to avoid adding a dependency to a
 * project that currently has four. Swapping it later is a drop-in change.
 */
const buckets = new Map();

/** Identify the caller. `trust proxy` is set, so req.ip is the real client. */
function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Drop windows that ended long ago.
 *
 * Without this the map grows once per distinct client IP forever, which is a
 * slow memory leak that only shows up in production.
 */
function sweep(now) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Build a limiter.
 *
 * @param {object} options
 * @param {number} options.windowMs  Window length.
 * @param {number} options.max       Requests allowed per window per client.
 * @param {string} options.name      Bucket namespace, so limiters do not share counts.
 */
export function rateLimit({ windowMs, max, name }) {
  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();

    if (now - lastSweep > SWEEP_INTERVAL_MS) {
      sweep(now);
      lastSweep = now;
    }

    const key = name + ':' + clientKey(req);
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);

    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(remaining));
    res.set('RateLimit-Reset', String(resetSeconds));

    if (bucket.count > max) {
      res.set('Retry-After', String(resetSeconds));
      return res.status(429).json({
        error: 'Too many requests',
        detail:
          'Rate limit reached. Try again in ' + resetSeconds + ' second' +
          (resetSeconds === 1 ? '' : 's') + '.',
        code: 'RATE_LIMITED',
        retryAfterSeconds: resetSeconds,
      });
    }

    return next();
  };
}

/**
 * Two tiers, because the costs are not the same.
 *
 * `general` covers reads and preference writes, which are cheap and local.
 * `ai` covers everything that calls a paid upstream, and is what actually
 * protects the bill. The numbers are sized for a handful of demo users, not a
 * launch: raise them deliberately when there is traffic to justify it.
 */
export const generalLimiter = rateLimit({ windowMs: 60_000, max: 120, name: 'general' });

export const aiLimiter = rateLimit({ windowMs: 60_000, max: 20, name: 'ai' });

/* ------------------------------------------------------------------ *
 * CORS
 * ------------------------------------------------------------------ */

/**
 * CORS options.
 *
 * A native mobile client sends no `Origin` header, so CORS is irrelevant to the
 * app itself and requests without an origin are allowed. What this does stop is
 * a web page in someone's browser quietly calling this API with their session.
 *
 * Set CORS_ORIGINS to a comma-separated allow-list when a web client exists.
 * Unset means "no browser origin is allowed", which is the correct default for
 * a mobile-only backend.
 */
export function corsOptions() {
  const raw = process.env.CORS_ORIGINS;
  const allowed = typeof raw === 'string' && raw.trim().length > 0
    ? raw.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [];

  return {
    origin(origin, callback) {
      // No Origin: a native app, curl, or a server-to-server call. Not a browser.
      if (!origin) return callback(null, true);
      if (allowed.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: false,
  };
}
