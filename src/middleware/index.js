/**
 * ULTRON AIR - Express middleware (no external dependencies).
 *
 * Exports (contract - do not rename):
 *   asyncHandler(fn)
 *   validateBody(rules)
 *   notFound(req, res)
 *   errorHandler(err, req, res, next)
 *   requestLogger(req, res, next)
 *
 * Design notes
 *  - PRIVACY: this file deliberately never touches req.body when logging. Request bodies on
 *    this API carry raw voice transcripts, contact names, notification text and coordinates.
 *  - SECURITY: nothing that leaves this file towards the client may contain an API key,
 *    a Mongo connection string, or a raw upstream response body.
 */

/* ------------------------------------------------------------------ *
 * Log level gate
 * LOG_LEVEL = silent | error | warn | info | debug   (default: info)
 * ------------------------------------------------------------------ */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

function levelValue() {
  const raw = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw] === undefined ? LEVELS.info : LEVELS[raw];
}

function enabled(level) {
  return levelValue() >= LEVELS[level];
}

/* ------------------------------------------------------------------ *
 * Secret scrubbing
 * ------------------------------------------------------------------ */

// Env vars whose *values* must never appear in a log line or a client payload.
const SECRET_ENV_KEYS = ['GEMINI_API_KEY', 'SARVAM_API_KEY', 'MONGODB_URI'];

const SECRET_PATTERNS = [
  // key=..., "api-subscription-key: ...", Authorization: Bearer ...
  /\b(api[-_ ]?key|api[-_ ]?subscription[-_ ]?key|subscription[-_ ]?key|authorization|bearer|access[-_ ]?token|token)\b\s*[:=]\s*["']?[^\s"',}]+/gi,
  /\bAIza[0-9A-Za-z\-_]{10,}\b/g, // Google API keys
  /\bsk-[A-Za-z0-9\-_]{10,}\b/g, // generic "sk-" style keys
  /\bsk_[A-Za-z0-9\-_]{10,}\b/g,
  /mongodb(\+srv)?:\/\/\S+/gi, // connection strings carry user:pass@host
  /[?&](key|api_key|apikey|token)=[^&\s]+/gi, // query-string keys (Gemini REST uses ?key=)
];

/**
 * Remove anything secret-shaped from a string. Used on BOTH the server log line and the
 * client-facing detail, because upstream SDK/fetch errors love to echo the request URL.
 */
function scrub(input) {
  if (input === undefined || input === null) return '';
  let out = String(input);

  for (const name of SECRET_ENV_KEYS) {
    const value = process.env[name];
    if (value && value.length >= 6) out = out.split(value).join('[redacted]');
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      if (/[:=]/.test(match)) {
        const label = match.split(/[:=]/)[0].trim();
        return label + '=[redacted]';
      }
      return '[redacted]';
    });
  }
  return out;
}

/** Client-facing detail must be short: a raw upstream HTML error page is useless and leaky. */
function clip(text, max = 300) {
  const s = scrub(text);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/* ------------------------------------------------------------------ *
 * asyncHandler
 * ------------------------------------------------------------------ */

/**
 * Wrap an async route handler so a rejected promise reaches errorHandler instead of
 * hanging the request forever (Express 4 does not await handlers).
 *
 *   router.post('/', asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('asyncHandler(fn): fn must be a function');
  }
  return function wrapped(req, res, next) {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.then === 'function') {
        result.catch(next);
      }
      return result;
    } catch (err) {
      // A synchronous throw inside an async-looking handler.
      next(err);
      return undefined;
    }
  };
}

/* ------------------------------------------------------------------ *
 * validateBody
 * ------------------------------------------------------------------ */

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/**
 * Coerce the string forms that arrive from form posts / older mobile builds.
 * Returns { ok, value }.
 */
function coerce(value, type) {
  if (type === 'number') {
    if (typeof value === 'number') return { ok: Number.isFinite(value), value };
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      return { ok: Number.isFinite(n), value: n };
    }
    return { ok: false, value };
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    if (value === 'true' || value === 1 || value === '1') return { ok: true, value: true };
    if (value === 'false' || value === 0 || value === '0') return { ok: true, value: false };
    return { ok: false, value };
  }
  return { ok: typeOf(value) === type, value };
}

/**
 * Declarative body validation.
 *
 *   validateBody({
 *     userId: { type: 'string', required: true, max: 128 },
 *     text:   { type: 'string', max: 2000 },
 *     mode:   { enum: ['off', 'anc', 'transparency'] },
 *     volume: { type: 'number', min: 0, max: 100 },
 *   })
 *
 * Rules
 *  - required : field must be present and non-empty
 *  - type     : 'string' | 'number' | 'boolean' | 'object' | 'array'
 *  - min/max  : length for strings & arrays, numeric value for numbers
 *  - enum     : value must be one of the listed values
 *
 * Unknown fields are ALLOWED through untouched: the mobile app ships independently of the
 * backend and must be able to send new fields to an older server without being rejected.
 *
 * On failure: 400 { error, detail, fields }.
 */
export function validateBody(rules) {
  const spec = rules && typeof rules === 'object' ? rules : {};

  return function validate(req, res, next) {
    // express.json() leaves req.body undefined when there is no body at all.
    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const fields = {};

    for (const [name, rawRule] of Object.entries(spec)) {
      const rule = rawRule && typeof rawRule === 'object' ? rawRule : {};
      const value = body[name];

      // Presence: undefined, null and '' all count as "not supplied".
      // `false` and `0` are real values and must survive this check.
      const supplied = value !== undefined && value !== null && value !== '';

      if (!supplied) {
        if (rule.required) fields[name] = 'is required';
        continue; // optional + absent: nothing else to check
      }

      const type = rule.type || (Array.isArray(rule.enum) ? 'string' : null);

      if (type) {
        if (!['string', 'number', 'boolean', 'object', 'array'].includes(type)) {
          // A bad rule is a programming error, not a client error - fail loudly in logs.
          if (enabled('warn')) {
            console.warn('[validate] unknown rule type "' + type + '" for field "' + name + '"');
          }
        } else {
          const checked = coerce(value, type);
          if (!checked.ok) {
            fields[name] = 'must be a ' + type + ' (received ' + typeOf(value) + ')';
            continue;
          }
          // Write the coerced value back so handlers get a real number/boolean.
          body[name] = checked.value;
        }
      }

      const finalValue = body[name];

      // min / max - length for strings & arrays, magnitude for numbers.
      let measure = null;
      if (typeof finalValue === 'string') {
        measure = { unit: 'characters', size: finalValue.length };
      } else if (Array.isArray(finalValue)) {
        measure = { unit: 'items', size: finalValue.length };
      } else if (typeof finalValue === 'number') {
        measure = { unit: null, size: finalValue };
      }

      if (measure) {
        if (rule.min !== undefined && measure.size < rule.min) {
          fields[name] = measure.unit
            ? 'must be at least ' + rule.min + ' ' + measure.unit
            : 'must be >= ' + rule.min;
          continue;
        }
        if (rule.max !== undefined && measure.size > rule.max) {
          fields[name] = measure.unit
            ? 'must be at most ' + rule.max + ' ' + measure.unit
            : 'must be <= ' + rule.max;
          continue;
        }
      }

      if (Array.isArray(rule.enum) && !rule.enum.includes(finalValue)) {
        fields[name] = 'must be one of: ' + rule.enum.join(', ');
      }
    }

    const failed = Object.keys(fields);
    if (failed.length === 0) return next();

    // NOTE: we report field NAMES and the reason, never the offending VALUE - the value
    // could be a transcript or a contact name.
    return res.status(400).json({
      error: 'Validation failed',
      detail: failed.map((f) => f + ' ' + fields[f]).join('; '),
      fields,
      code: 'VALIDATION_ERROR',
    });
  };
}

/* ------------------------------------------------------------------ *
 * requestLogger
 * ------------------------------------------------------------------ */

const ROUTE_PREFIXES = [
  '/health',
  '/api/assistant',
  '/api/speech',
  '/api/chat',
  '/api/translate',
  '/api/memory',
  '/api/device',
  '/api/safety',
];

/**
 * One line per request: method, path, status, duration in ms.
 *
 * PRIVACY - DO NOT ADD BODY LOGGING HERE, EVER.
 * Request bodies on this API contain raw voice transcripts, contact names ("call Mom"),
 * notification contents, base64 microphone audio and GPS coordinates. Logging them would
 * write a user's private life to stdout and into whatever log shipper is attached in
 * production. The query string is stripped for the same reason (it can carry ids).
 * If you need to inspect a payload, add a temporary log INSIDE the route while developing
 * locally and delete it before shipping.
 */
export function requestLogger(req, res, next) {
  if (!enabled('info')) return next();

  const startedAt = process.hrtime.bigint();
  const method = req.method;
  const path = String(req.originalUrl || req.url || '').split('?')[0];

  res.on('finish', () => {
    // /health is polled constantly by the mobile app - only show it at debug level.
    if (path === '/health' && !enabled('debug')) return;

    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const status = res.statusCode;
    const marker = status >= 500 ? '!!' : status >= 400 ? ' !' : '  ';
    console.log(marker + ' ' + method + ' ' + path + ' ' + status + ' ' + ms.toFixed(1) + 'ms');
  });

  return next();
}

/* ------------------------------------------------------------------ *
 * notFound
 * ------------------------------------------------------------------ */

/** 404 handler - mounted after all routes, before errorHandler. */
export function notFound(req, res) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  res.status(404).json({
    error: 'Not found',
    detail: 'No route for ' + req.method + ' ' + path,
    code: 'NOT_FOUND',
    availableRoutes: ROUTE_PREFIXES,
  });
}

/* ------------------------------------------------------------------ *
 * errorHandler
 * ------------------------------------------------------------------ */

function defaultCodeFor(status) {
  if (status === 400) return 'VALIDATION_ERROR';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 502) return 'UPSTREAM_FAILURE';
  if (status === 503) return 'SERVICE_NOT_CONFIGURED';
  return 'INTERNAL_ERROR';
}

/**
 * Decide the HTTP status + machine-readable code for an error thrown anywhere in the app.
 *
 * Mapping (per spec):
 *   validation error        -> 400 VALIDATION_ERROR
 *   missing / unset API key -> 503 SERVICE_NOT_CONFIGURED
 *   upstream API failure    -> 502 UPSTREAM_FAILURE (timeouts: UPSTREAM_TIMEOUT)
 *   anything else           -> 500 INTERNAL_ERROR
 */
function classify(err) {
  const name = String((err && err.name) || '');
  const code = String((err && err.code) || '');
  const message = String((err && err.message) || '');
  const explicit = Number(err && (err.status !== undefined ? err.status : err.statusCode));

  // 1. An explicit status set by a route wins (errors we construct ourselves).
  if (Number.isFinite(explicit) && explicit >= 400 && explicit <= 599) {
    return { status: explicit, code: code || defaultCodeFor(explicit) };
  }

  // 2. Body-parser failures (malformed JSON, oversized base64 audio).
  if ((err && err.type === 'entity.parse.failed') || name === 'SyntaxError') {
    return { status: 400, code: 'MALFORMED_JSON' };
  }
  if (err && err.type === 'entity.too.large') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE' };
  }

  // 3. Validation (ours, or a mongoose ValidationError/CastError).
  if (code === 'VALIDATION_ERROR' || name === 'ValidationError' || name === 'CastError') {
    return { status: 400, code: 'VALIDATION_ERROR' };
  }

  // 4. Not configured - the operator forgot a key. This is a 503 (works once it is set),
  //    NOT a 500, so the app can show "Gemini not configured" instead of "crash".
  if (
    code === 'MISSING_API_KEY' ||
    code === 'NOT_CONFIGURED' ||
    code === 'SERVICE_NOT_CONFIGURED' ||
    /\b(not configured|missing .*(api )?key|api key (is )?(missing|not set))\b/i.test(message)
  ) {
    return { status: 503, code: 'SERVICE_NOT_CONFIGURED' };
  }

  // 5. Upstream (Gemini / Sarvam / Mongo / any fetch) failure.
  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'ABORT_ERR' ||
    code === 'UPSTREAM_TIMEOUT' ||
    /timed? ?out/i.test(message)
  ) {
    return { status: 502, code: 'UPSTREAM_TIMEOUT' };
  }
  if (
    code === 'UPSTREAM_FAILURE' ||
    code === 'UPSTREAM_ERROR' ||
    (err && err.service) || // our services attach { service: 'gemini' | 'sarvam' }
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code) ||
    name === 'FetchError' ||
    name === 'MongoServerSelectionError' ||
    /\b(gemini|sarvam|upstream|fetch failed|bad gateway)\b/i.test(message)
  ) {
    return { status: 502, code: 'UPSTREAM_FAILURE' };
  }

  return { status: 500, code: 'INTERNAL_ERROR' };
}

// What the client is told. Deliberately generic for 5xx: the real cause is in the server log.
const PUBLIC_MESSAGE = {
  VALIDATION_ERROR: 'Validation failed',
  MALFORMED_JSON: 'Request body was not valid JSON',
  PAYLOAD_TOO_LARGE: 'Request body too large',
  NOT_FOUND: 'Not found',
  RATE_LIMITED: 'Too many requests',
  SERVICE_NOT_CONFIGURED: 'This feature is not configured on the server',
  UPSTREAM_TIMEOUT: 'An upstream AI service timed out',
  UPSTREAM_FAILURE: 'An upstream AI service is unavailable',
  INTERNAL_ERROR: 'Something went wrong on the server',
};

/**
 * Terminal error handler. MUST keep all four arguments or Express will treat it as a
 * normal middleware and never call it.
 */
export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const classified = classify(err);
  const status = classified.status;
  const code = classified.code;

  // ---- server-side log (full stack, scrubbed of keys) -------------------------------
  if (enabled('error')) {
    const method = (req && req.method) || '-';
    const path = String((req && req.originalUrl) || '').split('?')[0] || '-';
    const service = err && err.service ? ' [' + err.service + ']' : '';
    console.error(
      '!! ' + status + ' ' + code + service + ' on ' + method + ' ' + path + ': ' +
        scrub(err && err.message)
    );
    // Stack only - never req.body (transcripts / contacts / location live there).
    if (err && err.stack && enabled('warn')) console.error(scrub(err.stack));
    if (err && err.cause && err.cause.message) {
      console.error('   cause: ' + scrub(err.cause.message));
    }
  }

  if (res.headersSent) {
    // Something already started streaming a response; just close it cleanly.
    return res.end();
  }

  // ---- client-side payload ----------------------------------------------------------
  const body = {
    error: PUBLIC_MESSAGE[code] || PUBLIC_MESSAGE.INTERNAL_ERROR,
    // For 4xx the message is ours and safe to forward. For 5xx it may be an upstream body
    // or a URL containing ?key=..., so it is scrubbed and clipped hard.
    detail: clip((err && err.message) || '', status < 500 ? 300 : 200),
    code,
  };

  if (err && err.fields && typeof err.fields === 'object') body.fields = err.fields;
  if (err && err.service) body.service = String(err.service); // 'gemini' | 'sarvam' | 'mongo'

  // 5xx here are transient by nature - tell the app it is worth retrying.
  if (status >= 500) body.retryable = true;

  return res.status(status).json(body);
}

export default {
  asyncHandler,
  validateBody,
  notFound,
  errorHandler,
  requestLogger,
};
