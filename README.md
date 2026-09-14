# ULTRON AIR — Backend

The "brain" behind the ULTRON AIR earbuds. An Expo/React Native Android app captures voice,
sends it here, and this service decides **what the user meant** and **what should happen next**.

- **Gemini** — language understanding, intent detection, multi-step planning, replies.
- **Sarvam AI** — Indian-language speech: TTS (`bulbul:v2`) and STT.
- **MongoDB** — memory, preferences, safety profile, conversation history. *Optional.*

> **The honesty rule, stated once, applies everywhere below.**
> The server **plans** actions. The **phone executes them**. No response from this API ever
> says an action happened until the client has reported that it happened, via
> `POST /api/assistant/report`. "Calling Mom now" is a lie the backend is not allowed to tell.
>
> Environmental sound classification (horn / siren detection) is **not implemented**. It is a
> planned capability and `/health` reports `capabilities.environmentalSoundDetection: false`.

---

## 1. Run it

```bash
cd server
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm run dev               # nodemon, or: npm start
```

Requires **Node 18+** (global `fetch`, ESM). The project is `"type": "module"` — relative
imports must include the `.js` extension.

The server binds `0.0.0.0`, and the startup banner prints the LAN URL:

```
==========================================================
  ULTRON AIR API v1.0.0  (development)
==========================================================
  [ on ] Gemini      model gemini-2.0-flash
  [ off] Sarvam AI   SARVAM_API_KEY missing - no voice in/out, text only
  [ off] MongoDB     not connected - using in-memory store (data is lost on restart)
----------------------------------------------------------
  routes: /api/assistant  /api/speech  /api/chat  ...
----------------------------------------------------------
  local : http://localhost:4000/health
  LAN   : http://192.168.1.7:4000  <- use this on the phone
==========================================================
```

Put that LAN URL in the mobile app's `API_BASE_URL`. `localhost` on a phone means the phone.

**It boots with nothing configured.** No Mongo, no keys, no internet — it still listens, and
`/health` tells the app exactly what is degraded. See §6.

Environment variables are documented inline in [`.env.example`](./.env.example).

---

## 2. Shape of the system

```
mobile app                     this server                       upstream
──────────                     ───────────                       ────────
mic ──► base64 audio ──► POST /api/speech/stt ─────────────────► Sarvam STT
                                    │ transcript
 text ─────────────────► POST /api/assistant/turn
                                    │
                                    ├─ store.js      recall memory + prefs + recent turns
                                    ├─ gemini.js     intent + confidence + plan ──► Gemini
                                    ├─ intents.js    permissions, risk, confirmation policy
                                    └─ orchestrator  assemble TurnResult
                                    │
                          { plan, actions, reply, needsConfirmation }
                                    │
phone executes the action ──► POST /api/assistant/report  (what actually happened)
                                    │
                          reply text reflecting the REAL outcome
```

Source layout:

| File | Role |
|---|---|
| `src/index.js` | app wiring, `/health`, mounting, graceful shutdown |
| `src/middleware/index.js` | `asyncHandler`, `validateBody`, `requestLogger`, `notFound`, `errorHandler` |
| `src/services/store.js` | the only persistence layer routes touch (Mongo **or** in-memory) |
| `src/services/gemini.js` | `askGemini`, `generateStructured`, `translateText`, session history |
| `src/services/sarvam.js` | `textToSpeech`, `speechToText` |
| `src/services/intents.js` | the intent registry: params, permissions, risk, who executes |
| `src/services/orchestrator.js` | `runTurn()` — the ASK → UNDERSTAND → ACT pipeline |
| `src/routes/*.js` | thin HTTP adapters; no business logic lives here |

---

## 3. API reference

Base URL: `http://<host>:4000`. Everything is JSON. `Content-Type: application/json`.
Request bodies cap at **12 MB** (base64 audio).

### 3.1 Health

#### `GET /health`

The one endpoint the app polls to decide what to show as degraded.

```json
{
  "ok": true,
  "service": "ULTRON AIR API",
  "uptime": 412,
  "db": false,
  "gemini": true,
  "sarvam": false,
  "version": "1.0.0",
  "degraded": ["mongodb", "sarvam"],
  "capabilities": { "environmentalSoundDetection": false }
}
```

`ok: true` means *the process is serving requests* — not that everything works. Read `db`,
`gemini`, `sarvam`. Never returns a key or a connection string.

---

### 3.2 Assistant — `/api/assistant`

The primary surface. Everything else is a convenience wrapper around it.

#### `POST /api/assistant/turn`

One turn of conversation: transcribe (if audio), understand, plan, reply.

```jsonc
{
  "userId": "device-abc123",        // required, <= 128 chars
  "text": "Ultron, Mom ko call karo", // text OR audioBase64 - at least one is required
  "audioBase64": null,              // raw clip; the server runs STT first
  "mimeType": "audio/m4a",          // what the phone actually recorded (expo-av = m4a)
  "fileName": "turn.m4a",
  "languageCode": "hi-IN",          // default hi-IN
  "speak": true,                    // synthesize the reply (default true)
  "confirm": null,                  // true/false when answering a confirmation prompt
  "context": {                      // ALL optional; unknown keys are dropped, never trusted
    "grantedPermissions": ["microphone", "bluetooth", "contacts", "phone"],
    "connection": "connected",
    "battery": 72,
    "device": { "model": "ULTRON AIR" },
    "playback": { "playing": false },
    "noiseMode": "anc",
    "drivingMode": false,
    "safetyMode": false,
    "inCall": false,
    "incomingCall": null,
    "offline": false,
    "contactResolution": null,      // what the phone found when it looked up a name
    "nearMatches": [],              // ambiguous contact candidates, names only
    "notificationSummary": null,
    "lastActionResult": null
  }
}
```

**200** — the `TurnResult`, plus `transcript`, `audio` and `languageCode`:

```jsonc
{
  "transcript": "Ultron, Mom ko call karo",
  "intent": "call_contact",
  "confidence": 0.94,
  "contextUsed": { "grantedPermissions": ["contacts","phone"], "recentTurns": [], "memories": [] },
  "plan": [
    { "step": 1, "description": "Place a call to Mom", "intent": "call_contact", "params": { "contactName": "Mom" } }
  ],
  "actions": [
    {
      "id": "act_m1x8k2_1",
      "intent": "call_contact",
      "params": { "contactName": "Mom" },
      "requiresConfirmation": true,
      "requiredPermissions": ["contacts", "phone"],
      "executedBy": "client",
      "status": "planned"
    }
  ],
  "reply": "Mom ko call karun?",
  "needsConfirmation": true,
  "needsPermission": [],
  "followUp": "awaiting_confirmation",
  "fallback": false,
  "error": null,
  "degraded": null,
  "audio": "<base64>|null",
  "languageCode": "hi-IN"
}
```

`status` on an action is **always `"planned"`**. There is no server-side "done" — the only
thing that records an outcome is the client calling `/report`. `followUp` is a hint for the
app: `awaiting_confirmation`, `request_permission`, `need_contact_name`,
`disambiguate_contact`, `clarification`, `retry_command`, `awaiting_command`.

Errors: `400 VALIDATION_ERROR` (middleware, with `fields`), `400 { error: "bad_request",
message }` when neither `text` nor `audioBase64` is supplied, `413` when `text` > 4000 chars
or `audioBase64` > ~8 MB. Gemini being down does **not** error — you get `200` with
`fallback: true` and `degraded: "no_language_model"`.

#### `POST /api/assistant/confirm`

The user answered a `needsConfirmation` prompt.

```json
{ "userId": "device-abc123", "confirm": true, "planId": null, "languageCode": "hi-IN", "speak": true }
```

**200** — a `TurnResult` plus `confirmed`, `cancelled`, `planId`, `audio`, `languageCode`.
On `confirm: false` the pending plan is dropped and the reply is a clean cancellation.
On `confirm: true` the reply is a **hand-off** line ("theek hai, call laga raha hoon"),
present tense — the phone has not dialled yet.

#### `POST /api/assistant/report`

**The honesty callback.** The phone tells the server what actually happened.

```json
{
  "userId": "device-abc123",
  "actionId": "act_m1x8k2_1",
  "intent": "call_contact",
  "status": "done",
  "detail": "call connected",
  "languageCode": "hi-IN",
  "speak": true
}
```

`status` is exactly `"done"` or `"failed"` (validated twice — this one field decides whether
ULTRON is allowed to speak in the past tense).

**200**:

```json
{
  "ok": true, "userId": "device-abc123", "actionId": "act_m1x8k2_1", "intent": "call_contact",
  "knownIntent": true, "status": "done", "detail": "call connected",
  "recorded": true, "safetyLogged": false,
  "reply": "Ho gaya.", "audio": "<base64>|null", "languageCode": "hi-IN", "degraded": null
}
```

`recorded: false` means the acknowledgement was spoken but could not be persisted (store
down) — the app should not treat it as durable history.

#### `POST /api/assistant/reset`

```json
{ "userId": "device-abc123", "languageCode": "hi-IN", "speak": false }
```

**200** `{ ok, userId, cleared: { session, conversation }, memoriesKept: true, reply, audio, languageCode, degraded }`

Clears the chat. **Does not** clear long-term memories — "forget this conversation" is not
"forget the facts I asked you to remember".

#### `GET /api/assistant/intents`

The shared contract served from one place, so the app and the server cannot drift.

**200** `{ count, names, permissions, intents: INTENT_REGISTRY, byPhase, drift }` — `drift` is
non-null when `INTENT_NAMES` and `INTENT_REGISTRY` disagree, which is a bug alarm, not data.

---

### 3.3 Speech — `/api/speech`

#### `POST /api/speech/tts`

```json
{ "text": "Mom ko call karun?", "languageCode": "hi-IN", "speaker": "meera", "pace": 1 }
```

**200 (success)** `{ ok: true, audio: "<base64>", languageCode, speaker, model: "bulbul:v2", encoding: "base64", degraded: null, warning }`
**200 (degraded)** `{ ok: false, audio: null, text, degraded: "tts_failed:...", error, hint }`
— a failure is still a 200, because "show the text instead" is a working outcome.
**503** `SERVICE_NOT_CONFIGURED` when `SARVAM_API_KEY` is unset.

#### `POST /api/speech/stt`

```json
{ "audioBase64": "<base64>", "languageCode": "hi-IN", "mimeType": "audio/m4a", "fileName": "clip.m4a" }
```

**200 (success)** `{ ok: true, transcript: "Mom ko call karo", languageCode, empty: false, degraded: null, warning }`
**200 (degraded)** `{ ok: false, transcript: null, degraded: "stt_failed:...", error, hint }`

`transcript: ""` with `empty: true` means **silence** — a real answer. `transcript: null`
means **recognition is down**. The app must react differently to the two, so they are
deliberately distinct. **503** when Sarvam is unconfigured; there is no server-side offline
STT, so the app should fall back to the device recogniser.
**413** when the clip exceeds ~8 MB of base64.

#### `GET /api/speech/voices`

Static catalogue of languages/speakers. Answers **even without a key** (with
`configured: false`) because the app renders the language picker before onboarding ends.

---

### 3.4 Chat — `/api/chat` *(deprecated)*

Kept so the already-shipped screens keep working. A thin shim over `runTurn()`.

```json
{ "userId": "device-abc123", "message": "hello", "speak": true, "languageCode": "hi-IN" }
```

**200** `{ "reply": "...", "audio": "<base64>|null" }` — exactly the legacy shape, nothing
added. Extra signal rides on response headers: `X-Ultron-Intent`,
`X-Ultron-Needs-Confirmation`, `X-Ultron-Degraded`, `X-Ultron-Deprecated`.
`text` is accepted as an alias for `message`. Failures degrade to a 200 + fallback reply
rather than the old 502, because the shipped app shows a raw error toast on a non-200.

Migrate to `POST /api/assistant/turn`.

---

### 3.5 Translate — `/api/translate`

#### `POST /api/translate`

```json
{ "text": "Where is the station?", "targetLanguage": "Hindi", "targetLanguageCode": "hi-IN", "sourceLanguage": "auto", "speak": true }
```

**200** `{ translation, translated, audio, sourceLanguage, targetLanguage, targetLanguageCode, degraded, error }`

`translated` is a boolean: `false` means the text came back unchanged (Gemini down) and
`degraded` says why. `audio` is `null` when TTS is unavailable.

#### `POST /api/translate/conversation`

Same body plus `userId` and `side` — keeps a two-sided conversation buffer so the second
speaker's turn is translated *in context* of the first.
`DELETE /api/translate/conversation/:userId` clears that buffer.

#### `GET /api/translate/languages`

Supported languages and their codes. Works with no key configured.

---

### 3.6 Memory — `/api/memory`

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `POST` | `/api/memory` | `{ userId, text, kind?, tags?, source? }` | `{ saved: true, entry }` |
| `GET` | `/api/memory/:userId` | `?limit=50` | `{ entries, count, limit }`, newest first |
| `GET` | `/api/memory/:userId/search` | `?q=...&limit=10` | `{ entries, query, count }` |
| `DELETE` | `/api/memory/:id` | — | `{ deleted: true }` |
| `DELETE` | `/api/memory/user/:userId` | `?dryRun=true` | `{ deleted: <count> }` |

`kind` is one of `note`, `fact`, `preference`, `reminder`, `contact`, `task`.
Backed by `store.js`, so it works with Mongo down — entries just do not survive a restart,
and a store failure returns `degraded: "memory-store-unavailable"` with an empty list rather
than a 500.

---

### 3.7 Device — `/api/device`

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/device/:deviceId` | — | `{ user }` — created with defaults if absent |
| `PATCH` | `/api/device/:deviceId` | any of the preference fields below | `{ user, updatedFields, note }` |
| `POST` | `/api/device/:deviceId/state` | live telemetry | `{ state, ignoredFields }` |
| `GET` | `/api/device/:deviceId/state` | — | last reported telemetry |

Preference fields: `preferredLanguage`, `soundProfile`, `noiseControl`, `responseStyle`,
`wakeWord`, `voice`, `notificationRules`, `touchMappings`, `privacy`, `offline`,
`accessibility`. An unknown field is a 400 with `allowedFields` — for preferences a typo
means silent data loss, so it fails loudly.

Telemetry (`/state`: `connected`, `battery`, `batteryLeft`, `batteryRight`, `batteryCase`,
`firmware`, `noiseMode`, `model`, `name`, `inEar`, `charging`) is forward-compatible
instead: unknown keys are dropped and echoed in `ignoredFields`, because newer firmware must
not 400 the whole sync.

**`PATCH` records a preference. It does not change the earbuds.** The response says so in
`note`. The phone applies the setting over BLE and confirms via `/api/assistant/report`.

---

### 3.8 Safety — `/api/safety`

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/safety/:userId/profile` | — | `{ profile }` |
| `PATCH` | `/api/safety/:userId/profile` | `emergencyContacts`, `trustedContacts`, `safetyMode`, `drivingMode` | `{ profile, updatedFields }` |
| `POST` | `/api/safety/:userId/events` | `{ kind, confidence?, level?, action?, location? }` | the stored event |
| `GET` | `/api/safety/:userId/events` | `?limit=50` | `{ events, count }` |
| `POST` | `/api/safety/:userId/emergency` | `{ trigger: "voice"\|"manual", confirm?, location?, languageCode?, speak? }` | plan + reply |

`kind` is one of `loud_sound`, `horn`, `siren`, `alarm`, `shout`, `impact`, `glass_break`,
`emergency_trigger`, `unknown`.

> **These events are *reported by the client*, not detected by the server.** The backend does
> no audio classification at all. A `horn` event means the phone said "horn"; `/health`
> reports `capabilities.environmentalSoundDetection: false` for exactly this reason.

A failed profile write returns **503** with `saved: false` and an explicit "retry before
relying on them" message — a safety setting that silently failed to save is the worst
possible outcome, so it is never reported as saved. Repeated identical events are throttled
by `SAFETY_EVENT_COOLDOWN_MS`. `/emergency` returns a **plan** to contact someone; the phone
places the call and reports back.

---

### 3.9 Errors

Anything that reaches the shared error handler has this shape:

```json
{ "error": "An upstream AI service is unavailable", "detail": "gemini: 503 from generateContent", "code": "UPSTREAM_FAILURE", "retryable": true }
```

| Status | `code` | Means |
|---|---|---|
| 400 | `VALIDATION_ERROR` | bad/missing field — also carries `fields: { name: reason }` |
| 400 | `MALFORMED_JSON` | body was not valid JSON |
| 404 | `NOT_FOUND` | no such route — the response lists `availableRoutes` |
| 413 | `PAYLOAD_TOO_LARGE` | text or audio over the per-route cap |
| 502 | `UPSTREAM_FAILURE` | Gemini/Sarvam refused or errored after retries |
| 502 | `UPSTREAM_TIMEOUT` | upstream did not answer within its timeout |
| 503 | `SERVICE_NOT_CONFIGURED` | the key for that feature is not set |
| 503 | `ROUTE_UNAVAILABLE` | that route module failed to load; the rest of the API is fine |
| 500 | `INTERNAL_ERROR` | genuine bug — details are in the server log, not the response |

Some routes answer their own 4xx in a local shape (`{ error: "bad_request", message }`, or
`{ error, allowedFields }`) before the shared handler is reached. Both always carry `error`.

**The conversational routes prefer degradation to errors.** `/api/assistant/turn`,
`/api/speech/*` and `/api/translate` answer **200** with `degraded` set rather than a 502,
because a user mid-sentence needs a reply, not a status code. Check `degraded`, not just the
status code.

---

## 4. ASK → UNDERSTAND → ACT

1. **ASK** — audio in (`/api/speech/stt`, or `audioBase64` straight into `/turn`) or text in.
2. **UNDERSTAND** — `runTurn()` assembles context from an **allowlist** (recent turns,
   memories, device state, granted permissions — anything else the client sends is dropped),
   asks Gemini for a structured `{ intent, confidence, params, plan }`, then validates it
   against `INTENT_REGISTRY`: unknown intent → `unknown`; missing permission →
   `needsPermission`; `riskLevel: 'high'` → `needsConfirmation`.
3. **ACT** — the server emits `actions[]` for the **phone** to execute, and a reply that
   asks, hands off, or informs. The phone executes and calls `/api/assistant/report`.

### Worked example: "Ultron, call Mom"

**Hop 1 — transcribe.**

```
POST /api/speech/stt
{ "audioBase64": "UklGRi4AAAB...", "languageCode": "hi-IN", "mimeType": "audio/m4a" }
→ 200
{ "ok": true, "transcript": "Ultron, Mom ko call karo", "languageCode": "hi-IN", "empty": false, "degraded": null }
```

(Or skip this hop and post `audioBase64` directly to `/turn`, which runs STT itself.)

**Hop 2 — the turn.**

```
POST /api/assistant/turn
{
  "userId": "device-abc123",
  "text": "Ultron, Mom ko call karo",
  "languageCode": "hi-IN",
  "context": { "grantedPermissions": ["microphone","bluetooth","contacts","phone"], "drivingMode": false }
}
→ 200
{
  "transcript": "Ultron, Mom ko call karo",
  "intent": "call_contact",
  "confidence": 0.94,
  "contextUsed": { "grantedPermissions": ["microphone","bluetooth","contacts","phone"], "recentTurns": [], "memories": [] },
  "plan": [{ "step": 1, "description": "Place a call to Mom", "intent": "call_contact", "params": { "contactName": "Mom" } }],
  "actions": [{
    "id": "act_m1x8k2_1",
    "intent": "call_contact",
    "params": { "contactName": "Mom" },
    "requiresConfirmation": true,
    "requiredPermissions": ["contacts", "phone"],
    "executedBy": "client",
    "status": "planned"
  }],
  "reply": "Mom ko call karun?",
  "needsConfirmation": true,
  "needsPermission": [],
  "followUp": "awaiting_confirmation",
  "fallback": false,
  "error": null,
  "degraded": null,
  "audio": "<base64 of the question>",
  "languageCode": "hi-IN"
}
```

Note the reply: **a question**. Nothing has been dialled, and `status` is `"planned"`.

**Hop 3 — the user says "haan".**

```
POST /api/assistant/confirm
{ "userId": "device-abc123", "confirm": true, "languageCode": "hi-IN" }
→ 200
{
  "intent": "call_contact",
  "actions": [{ "id": "act_m1x8k2_1", "intent": "call_contact", "params": { "contactName": "Mom" },
                "requiresConfirmation": false, "requiredPermissions": ["contacts","phone"],
                "executedBy": "client", "status": "planned" }],
  "reply": "Theek hai, Mom ko call laga raha hoon.",
  "confirmed": true, "cancelled": false, "planId": null,
  "needsConfirmation": false, "needsPermission": [], "fallback": false, "error": null, "degraded": null,
  "audio": "<base64>", "languageCode": "hi-IN"
}
```

Still not a claim of success — "I'm placing the call", present tense, because the phone has
not dialled yet. The app now resolves "Mom" **on the device** against the OS contact store
(no phone number ever comes to the server) and starts the call.

**Hop 4 — the callback. This is what makes the reply true.**

```
POST /api/assistant/report
{ "userId": "device-abc123", "actionId": "act_m1x8k2_1", "intent": "call_contact",
  "status": "done", "detail": "call connected" }
→ 200
{ "ok": true, "actionId": "act_m1x8k2_1", "intent": "call_contact", "status": "done",
  "recorded": true, "safetyLogged": false,
  "reply": "Ho gaya.", "audio": "<base64>", "languageCode": "hi-IN", "degraded": null }
```

If the call had failed:

```
{ "userId": "device-abc123", "actionId": "act_m1x8k2_1", "intent": "call_contact",
  "status": "failed", "detail": "no SIM" }
→ 200
{ "ok": true, "status": "failed", "reply": "Call nahi lag payi." }
```

**Permission variant.** If `contacts` was not in `grantedPermissions`:

```json
{
  "intent": "call_contact",
  "actions": [{ "id": "act_m1x8k2_1", "status": "planned", "requiredPermissions": ["contacts","phone"], "...": "..." }],
  "reply": "Call karne ke liye mujhe contacts ki permission chahiye.",
  "needsConfirmation": false,
  "needsPermission": ["contacts"],
  "followUp": "request_permission"
}
```

The app shows the OS permission prompt and replays the turn. The server never pretends.

**Ambiguity variant.** If the phone reports two contacts matching "Mom", it sends them in
`context.nearMatches` and the reply comes back as a disambiguation question with
`followUp: "disambiguate_contact"` — names only, never numbers.

---

## 5. Degradation matrix

Nothing in this column list is theoretical — each is a normal state on a train with bad signal.

| Broken | Still works | Degraded | Dead |
|---|---|---|---|
| **No MongoDB** | everything: store falls back to an in-process Map; memory, prefs, safety profile, sessions all function | data is lost on restart; search is substring-only; `/health` → `db:false` | nothing |
| **No Gemini key / Gemini down** | every route answers 200; keyword intent matching still recognises the common commands; memory, device, safety, translate-passthrough, TTS | replies are canned, no multi-step planning, low confidence; `degraded:"no_language_model"`, `fallback:true` | nuanced understanding, open-ended Q&A |
| **No Sarvam key / Sarvam down** | all text paths; `audio` comes back `null` and the app renders text | voice-out silent; app should use on-device TTS | server-side STT (`/api/speech/stt` → 503) |
| **No internet at all** | `/health`, memory, device prefs, safety profile/events, `/api/assistant/turn` via keyword fallback | replies canned, audio null, `degraded:"no_language_model"` + `"tts_failed:..."` | anything needing Gemini or Sarvam |
| **A route module fails to load** | every other prefix | that prefix answers 503 `ROUTE_UNAVAILABLE`; the banner prints the stack | that one feature |

Design rules behind the table: every external call has a configured-key check, an
`AbortController` timeout, and a bounded retry with backoff on 429/5xx/network; a dead upstream
degrades one field, never a whole route; **no route returns 500 for an upstream problem.**

---

## 6. Security & privacy

- **No request bodies are ever logged.** `requestLogger` writes method, path, status and
  duration only. Bodies here hold voice transcripts, contact names, notification text, GPS
  and raw microphone audio. The query string is stripped from log lines too. There is a
  comment saying exactly this above the logger so nobody "helpfully" adds body logging.
- **No key ever reaches the client.** `errorHandler` scrubs the values of `GEMINI_API_KEY`,
  `SARVAM_API_KEY` and `MONGODB_URI` out of every message and stack, plus anything matching
  `?key=`, `Bearer …`, `AIza…`, `sk-…` and `mongodb://…`. Upstream response bodies are
  clipped, never forwarded raw. `/health` reports booleans, never values.
- **Contact data is never persisted server-side.** `"Mom"` is a *parameter of a planned
  action*. Name → phone number resolution happens on the phone against the OS contact store.
  No phone number, contact list or address book fragment is written to Mongo or the
  in-memory store. Emergency/trusted contacts in the safety profile are stored as the user
  explicitly entered them and exist only for that user's own safety flow.
- **The permission gate lives in the orchestrator**, not the routes and not the client.
  Every intent declares `requiredPermissions`; `runTurn()` compares them against
  `context.permissionsGranted` and returns `needsPermission` with the action marked
  `blocked_permission`. A client that forgets to send `permissionsGranted` gets actions
  blocked, not silently allowed — fail closed.
- **Confirmation is server-enforced.** `riskLevel: 'high'` intents (calling, emergency,
  sending a message) always come back `pending_confirmation`. A client cannot skip the
  round-trip by phrasing the request differently.
- **Honesty.** Past-tense success language is reachable from exactly one code path:
  `/api/assistant/report` with `status: "success"`. This matters because the product makes
  safety claims, and a safety claim that is sometimes fictional is worse than no claim.
- No auth yet — `userId` is a device id and is trusted. **Do not expose this server to the
  public internet as-is.** LAN / tunnel for development only.
