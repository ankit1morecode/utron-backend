import mongoose from "mongoose";

/**
 * ULTRON AIR — database bootstrap.
 *
 * Design rule: MongoDB is OPTIONAL at runtime. A missing or unreachable
 * MONGODB_URI is a loudly-logged, NON-FATAL condition: the server still boots
 * and every route keeps working through the in-memory fallback inside
 * services/store.js. Nothing in here may throw or call process.exit().
 */

// readyState values mongoose uses: 0 disconnected, 1 connected, 2 connecting, 3 disconnecting
const READY_STATE_CONNECTED = 1;

// Listeners are global on the connection singleton; guard so repeated
// connectDB() calls (tests, reconnect attempts) do not stack duplicates.
let listenersBound = false;
// Remembers the last state we printed so we log transitions, not every event.
let lastLoggedState = null;

function logTransition(state, detail) {
  if (lastLoggedState === state) return;
  lastLoggedState = state;
  const line = detail ? `[db] ${state}: ${detail}` : `[db] ${state}`;
  if (state === "error") console.error(line);
  else console.log(line);
}

function bindListeners() {
  if (listenersBound) return;
  listenersBound = true;

  const conn = mongoose.connection;

  conn.on("connected", () => logTransition("connected"));
  conn.on("disconnected", () =>
    logTransition("disconnected", "falling back to the in-memory store")
  );
  conn.on("reconnected", () => logTransition("connected", "reconnected"));
  conn.on("error", (err) => logTransition("error", err?.message || String(err)));
}

/**
 * Attempt a connection. Never throws — resolves either way.
 * @returns {Promise<boolean>} true when a live connection was established.
 */
export async function connectDB() {
  const uri = process.env.MONGODB_URI;

  bindListeners();

  if (!uri) {
    console.warn(
      "[db] MONGODB_URI is not set — starting WITHOUT MongoDB. " +
        "All routes stay available via the in-memory store; data will not survive a restart."
    );
    return false;
  }

  try {
    await mongoose.connect(uri, {
      // Fail fast instead of hanging the boot sequence for 30s on a dead host.
      serverSelectionTimeoutMS: Number(process.env.MONGODB_TIMEOUT_MS) || 8000,
      // Keep socket ops bounded so a stalled primary cannot wedge a request.
      socketTimeoutMS: 45000,
    });
    // Do not buffer model calls forever when the connection later drops;
    // store.js checks isDbReady() first, but this is a second line of defence.
    mongoose.set("bufferCommands", false);
    logTransition("connected", uri.replace(/\/\/[^@]*@/, "//<redacted>@"));
    return true;
  } catch (err) {
    console.error(
      `[db] MongoDB unreachable (${err?.message || err}) — continuing WITHOUT MongoDB. ` +
        "All routes stay available via the in-memory store; data will not survive a restart."
    );
    return false;
  }
}

/** True only when a live connection is usable right now. */
export function isDbReady() {
  return mongoose.connection?.readyState === READY_STATE_CONNECTED;
}

/** Close cleanly on shutdown. Never throws. */
export async function disconnectDB() {
  try {
    await mongoose.connection.close();
  } catch (err) {
    console.error("[db] error while closing connection:", err?.message || err);
  }
}

export default connectDB;
