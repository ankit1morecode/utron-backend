/**
 * ULTRON AIR - API entry point.
 *
 * Boot contract:
 *  - The server ALWAYS comes up. Mongo down, Gemini key missing, Sarvam key missing,
 *    no internet at all - it still listens and /health tells the phone what is degraded.
 *    store.js has an in-process fallback, so the API stays usable for a demo without Mongo.
 *  - It binds 0.0.0.0 so an Android phone on the same Wi-Fi can reach it.
 *
 * Middleware order matters: requestLogger -> body parser -> routes -> notFound -> errorHandler.
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requestLogger, notFound, errorHandler } from './middleware/index.js';
import {
  assertSecurityConfig,
  corsOptions,
  requireApiToken,
  generalLimiter,
  aiLimiter,
} from './middleware/security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * Version (read from package.json - no JSON import assertions needed)
 * ------------------------------------------------------------------ */
function readVersion() {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SERVICE = 'ULTRON AIR API';
const VERSION = readVersion();
const PORT = Number(process.env.PORT || 4000);
const HOST = '0.0.0.0'; // not 127.0.0.1: the phone is a different device on the LAN

/* ------------------------------------------------------------------ *
 * Tolerant module loading
 *
 * Sibling modules (store / orchestrator / new routes) are separate files. If one of them
 * fails to parse or is missing, a static import would take the WHOLE server down and every
 * feature with it. Instead each module is loaded defensively: the failure is printed in
 * full (so it is impossible to miss) and only the affected route degrades to 503.
 * ------------------------------------------------------------------ */
const bootIssues = [];

async function loadModule(specifier, label) {
  try {
    return await import(specifier);
  } catch (err) {
    bootIssues.push({ label, specifier, message: err && err.message });
    console.error('\n[boot] FAILED to load ' + label + ' (' + specifier + ')');
    console.error(err && (err.stack || err.message));
    console.error('');
    return null;
  }
}

// --- core services: used by /health so the app knows what is available -----------------
const storeMod = await loadModule('./services/store.js', 'services/store.js');
const geminiMod = await loadModule('./services/gemini.js', 'services/gemini.js');
const sarvamMod = await loadModule('./services/sarvam.js', 'services/sarvam.js');
const dbMod = await loadModule('./config/db.js', 'config/db.js');

// Fall back to "false" probes so /health stays honest rather than throwing.
const isDbReady = (storeMod && storeMod.isDbReady) || (() => false);
// Prefer the "usable" probes: they report whether the upstream has actually
// ACCEPTED the key, not merely whether one is present. A server whose /health
// says gemini:true while every call 401s is the exact dishonesty this product
// is built to avoid. Fall back to the presence probes if an older services
// build does not export them.
const isGeminiConfigured = (geminiMod && geminiMod.isGeminiConfigured) || (() => false);
const isSarvamConfigured = (sarvamMod && sarvamMod.isSarvamConfigured) || (() => false);
const isGeminiUsable = (geminiMod && geminiMod.isGeminiUsable) || isGeminiConfigured;
const isSarvamUsable = (sarvamMod && sarvamMod.isSarvamUsable) || isSarvamConfigured;
const geminiCredentialError = (geminiMod && geminiMod.geminiCredentialError) || (() => null);
// Which model actually answered last. Not the same as GEMINI_MODEL: the
// service walks a fallback chain when a model's daily quota runs out, and
// reporting the configured value would hide that it had happened.
const activeGeminiModel =
  (geminiMod && geminiMod.activeGeminiModel) || (() => process.env.GEMINI_MODEL || null);
const sarvamCredentialError = (sarvamMod && sarvamMod.sarvamCredentialError) || (() => null);
const connectDB = (dbMod && dbMod.connectDB) || (async () => {});

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(cors(corsOptions()));

// 12mb: /api/speech/transcribe carries base64 PCM/WAV captured on the earbuds.
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Logger goes first so even a 400 from the body parser is recorded. It logs method, path,
// status and duration only - NEVER the body (voice transcripts / contacts / location).
app.use(requestLogger);

// Access control sits directly after the logger: a rejected request is still
// logged (so abuse is visible) but never reaches a route, a model, or the store.
// /health is exempt inside requireApiToken - the app polls it to decide what to
// show as degraded, and monitoring should not need a credential.
app.use(requireApiToken);

// Cheap, local routes. Generous, and mostly there to stop a runaway client loop.
app.use('/api', generalLimiter);

// Everything that spends money on an upstream model gets a much tighter budget.
// This is the limiter that actually protects the Gemini and Sarvam bill.
app.use('/api/assistant', aiLimiter);
app.use('/api/chat', aiLimiter);
app.use('/api/speech', aiLimiter);
app.use('/api/translate', aiLimiter);
// Vision sends a whole photograph to a multimodal model — by far the most
// expensive call this server can make. It shares the AI limiter deliberately.
app.use('/api/vision', aiLimiter);

/* ------------------------------------------------------------------ *
 * /health - the single endpoint the mobile app polls to decide what to show as degraded.
 * ------------------------------------------------------------------ */
app.get('/health', (req, res) => {
  const db = Boolean(isDbReady());
  const gemini = Boolean(isGeminiUsable());
  const sarvam = Boolean(isSarvamUsable());

  // Honest reporting: say what is missing, do not pretend a capability exists.
  const degraded = [];
  if (!db) degraded.push('mongodb');
  if (!gemini) degraded.push('gemini');
  if (!sarvam) degraded.push('sarvam');
  for (const issue of bootIssues) degraded.push(issue.label);

  res.json({
    ok: true, // the process is alive and serving; per-integration state is below
    service: SERVICE,
    uptime: Math.round(process.uptime()),
    db,
    gemini,
    sarvam,
    version: VERSION,
    // extra, additive fields - safe for older clients to ignore
    degraded,
    // Why an integration is down, when we know. Never contains key material,
    // so it is safe to show in the app and in a monitoring dashboard.
    issues: [geminiCredentialError(), sarvamCredentialError()].filter(Boolean),
    // The model currently answering. When this differs from GEMINI_MODEL, the
    // primary model's quota is exhausted or it has been retired, and replies
    // are coming from a fallback — worth seeing before someone reports that
    // "the AI got worse today".
    geminiModel: activeGeminiModel(),
    capabilities: {
      // Answers about ONE still photo via POST /api/vision. Not continuous
      // sight: obstacle and traffic-light tasks are refused with 501.
      vision: gemini,
      // Planned, NOT implemented. Never advertise this as working.
      environmentalSoundDetection: false,
    },
  });
});

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */
const ROUTES = [
  { prefix: '/api/assistant', file: './routes/assistant.js', label: 'assistant' },
  { prefix: '/api/speech', file: './routes/speech.js', label: 'speech' },
  // Legacy: the shipped mobile screens still call /api/chat. It is now a shim over runTurn().
  { prefix: '/api/chat', file: './routes/chat.js', label: 'chat (legacy)' },
  { prefix: '/api/translate', file: './routes/translate.js', label: 'translate' },
  { prefix: '/api/vision', file: './routes/vision.js', label: 'vision' },
  { prefix: '/api/memory', file: './routes/memory.js', label: 'memory' },
  { prefix: '/api/device', file: './routes/device.js', label: 'device' },
  { prefix: '/api/safety', file: './routes/safety.js', label: 'safety' },
];

const mounted = [];

for (const route of ROUTES) {
  const mod = await loadModule(route.file, 'routes' + route.prefix.replace('/api', ''));
  const router = mod && (mod.default || mod.router);

  if (typeof router === 'function') {
    app.use(route.prefix, router);
    mounted.push(route.prefix);
  } else {
    // Degrade, do not crash: this prefix answers 503 with an honest reason.
    if (mod) {
      bootIssues.push({
        label: 'routes' + route.prefix.replace('/api', ''),
        specifier: route.file,
        message: 'module has no default export (expected an express Router)',
      });
    }
    app.use(route.prefix, (req, res) => {
      res.status(503).json({
        error: 'This part of the API failed to load on the server',
        detail: route.prefix + ' is unavailable (' + route.file + ' did not load).',
        code: 'ROUTE_UNAVAILABLE',
        retryable: false,
      });
    });
  }
}

// 404 then the terminal error handler - both must come after every route.
app.use(notFound);
app.use(errorHandler);

/* ------------------------------------------------------------------ *
 * Startup banner
 * ------------------------------------------------------------------ */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function mark(ok) {
  return ok ? '[ on ]' : '[ off]';
}

function banner() {
  const db = Boolean(isDbReady());
  const gemini = Boolean(isGeminiConfigured());
  const sarvam = Boolean(isSarvamConfigured());

  const lines = [];
  lines.push('');
  lines.push('==========================================================');
  lines.push('  ' + SERVICE + ' v' + VERSION + '  (' + (process.env.NODE_ENV || 'development') + ')');
  lines.push('==========================================================');
  lines.push('  ' + mark(gemini) + ' Gemini      ' + (gemini
    ? 'model ' + (process.env.GEMINI_MODEL || 'gemini-2.0-flash')
    : 'GEMINI_API_KEY missing - replies fall back to canned text'));
  lines.push('  ' + mark(sarvam) + ' Sarvam AI   ' + (sarvam
    ? 'TTS + STT ready'
    : 'SARVAM_API_KEY missing - no voice in/out, text only'));
  lines.push('  ' + mark(db) + ' MongoDB     ' + (db
    ? 'connected'
    : 'not connected - using in-memory store (data is lost on restart)'));
  lines.push('----------------------------------------------------------');
  lines.push('  routes: ' + (mounted.length ? mounted.join('  ') : '(none mounted!)'));

  if (bootIssues.length) {
    lines.push('----------------------------------------------------------');
    lines.push('  !! ' + bootIssues.length + ' module(s) failed to load:');
    for (const issue of bootIssues) {
      lines.push('     - ' + issue.label + ': ' + issue.message);
    }
  }

  lines.push('----------------------------------------------------------');
  lines.push('  local : http://localhost:' + PORT + '/health');
  for (const ip of lanAddresses()) {
    // This is the URL to put in the Expo app's API_BASE_URL when testing on a real phone.
    lines.push('  LAN   : http://' + ip + ':' + PORT + '  <- use this on the phone');
  }
  if (!lanAddresses().length) {
    lines.push('  LAN   : no external IPv4 found - phone testing will not work');
  }
  lines.push('==========================================================');
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
let server;

async function start() {
  // Before anything listens: refuse to serve an unauthenticated API in
  // production. Exits the process rather than starting open.
  assertSecurityConfig();

  // Mongo is optional. Never let a failed/slow connection stop the server from listening -
  // store.js falls back to an in-process Map so every route keeps working.
  try {
    await connectDB();
  } catch (err) {
    console.warn('[boot] MongoDB unavailable: ' + (err && err.message));
    console.warn('[boot] continuing with the in-memory store (demo mode).');
  }

  server = app.listen(PORT, HOST, () => {
    console.log(banner());
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('[boot] port ' + PORT + ' is already in use. Set PORT in server/.env.');
    } else {
      console.error('[boot] listen failed: ' + (err && err.message));
    }
    process.exit(1);
  });

  // Base64 audio round-trips can be slow on a phone hotspot; give sockets room.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 120000;
}

/* ------------------------------------------------------------------ *
 * Graceful shutdown
 * ------------------------------------------------------------------ */
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[shutdown] ' + signal + ' received - closing...');

  // Stop accepting new connections, let in-flight requests finish.
  const closed = new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });

  // Hard cap: never hang a terminal waiting for a stuck upstream call.
  const timeout = new Promise((resolve) => setTimeout(resolve, 8000));
  await Promise.race([closed, timeout]);

  try {
    const mongoose = await import('mongoose').then((m) => m.default).catch(() => null);
    if (mongoose && mongoose.connection && mongoose.connection.readyState === 1) {
      await mongoose.connection.close(false);
      console.log('[shutdown] mongodb connection closed');
    }
  } catch {
    // nothing useful to do while exiting
  }

  console.log('[shutdown] bye');
  process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

// A stray rejection must not take the assistant offline mid-demo - log and carry on.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && (reason.stack || reason.message || reason));
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && (err.stack || err.message));
  shutdown('uncaughtException');
});

start();

export default app;
