// ---------------------------------------------------------------------------
// ULTRON AIR — INTENT REGISTRY
// ---------------------------------------------------------------------------
// This file is the single source of truth for *what ULTRON is allowed to do*.
// Three consumers read it:
//   1. orchestrator.js  — builds the classifier prompt, the plan, and the
//                         permission gate from these entries.
//   2. the mobile app   — the Expo client switches on `intent` + `params` to
//                         actually execute anything marked executedBy:'client'.
//   3. product docs     — phase / riskLevel describe the roadmap honestly.
//
// HONESTY RULE (product-wide): the server only ever *plans* actions. Nothing in
// this file executes a device action, and no description here may be read as a
// claim that the phone did something. The client executes and reports back.
//
// NOTHING here may be renamed without updating the mobile app: intent names and
// permission keys are a wire contract.
// ---------------------------------------------------------------------------

/**
 * Permission keys shared verbatim with the Expo/React Native client.
 * The permission gate in orchestrator.js compares against exactly these.
 */
export const PERMISSION_KEYS = [
  'microphone',
  'bluetooth',
  'contacts',
  'notifications',
  'location',
  'camera',
  'phone',
  'mediaControl',
];

/**
 * Why each permission is needed, phrased for a *spoken* explanation.
 * The permission gate speaks these instead of a bare "permission denied", which
 * is useless in a voice-first product.
 * `hi` is Hinglish on purpose — that is how the target user actually speaks.
 */
export const PERMISSION_RATIONALE = {
  microphone: {
    en: 'microphone access, so I can hear your commands',
    hi: 'microphone ki permission, taaki main aapki baat sun sakun',
  },
  bluetooth: {
    en: 'Bluetooth access, so I can talk to your earbuds',
    hi: 'Bluetooth ki permission, taaki main earbuds se baat kar sakun',
  },
  contacts: {
    en: 'contacts access, so I can find the right person to call',
    hi: 'contacts ki permission, taaki main sahi person dhoondh sakun',
  },
  notifications: {
    en: 'notification access, so I can read and reply to your messages',
    hi: 'notifications ki permission, taaki main messages padh sakun',
  },
  location: {
    en: 'location access, for navigation and emergency location sharing',
    hi: 'location ki permission, navigation aur emergency ke liye',
  },
  camera: {
    en: 'camera access, so I can look at what is in front of you',
    hi: 'camera ki permission, taaki main saamne ka scene dekh sakun',
  },
  phone: {
    en: 'phone access, so I can place and control calls',
    hi: 'phone ki permission, taaki main call laga aur control kar sakun',
  },
  mediaControl: {
    en: 'media control access, so I can control playback',
    hi: 'media control ki permission, taaki main gaana control kar sakun',
  },
};

/**
 * Emergency confirmation is a *cancel window*, not a dialogue.
 *
 * DOCUMENTED BEHAVIOUR: for `call_emergency` the orchestrator returns
 * needsConfirmation:true and puts `cancelWindowMs` on the action. The client
 * speaks one short line ("Emergency call in 5 seconds — say cancel to stop"),
 * starts a timer, and places the call when the timer expires unless the user
 * cancels. It must NOT ask a second question: a person in trouble cannot answer
 * a questionnaire, and a person who misfired has 5 seconds to say "cancel".
 */
export const EMERGENCY_CONFIRM_WINDOW_MS = 5000;

/**
 * The registry.
 *
 * Contract fields every consumer may rely on:
 *   name                  string
 *   description           one line, fed to the classifier prompt
 *   params                { [key]: 'string' | 'number' | 'boolean' }
 *   requiredPermissions   string[] — always required
 *   requiresConfirmation  boolean  — real-world consequence => true
 *   executedBy            'client' | 'server'
 *   phase                 1 | 2 | 3 | 4  (roadmap)
 *   riskLevel             'none' | 'low' | 'high'
 *
 * Optional additive fields (safe to ignore):
 *   conditionalPermissions  { paramName: string[] } — permission required only
 *                           when that param is truthy (e.g. sharing location on
 *                           an emergency call). The permission gate honours it.
 *   implemented             false => planned, not shipped. The orchestrator must
 *                           never imply such a capability works.
 *   notes                   engineering note, never spoken to the user.
 */
export const INTENT_REGISTRY = {
  // ---------------------------------------------------------------- calling
  call_contact: {
    name: 'call_contact',
    description: 'Place a phone call to a person named by the user.',
    params: {
      contactName: 'string',
      contactId: 'string',
      // "call Mom and put it on speaker" rides along here: there is
      // deliberately no separate speaker intent in the v1 name list.
      useSpeaker: 'boolean',
    },
    requiredPermissions: ['contacts', 'phone'],
    requiresConfirmation: true,
    executedBy: 'client',
    phase: 2,
    riskLevel: 'high',
  },

  call_emergency: {
    name: 'call_emergency',
    description:
      'Call an emergency or trusted contact because the user is in danger, hurt, or says help / bachao / madad.',
    params: {
      contactName: 'string', // optional: a specific trusted contact
      reason: 'string',
      shareLocation: 'boolean',
    },
    requiredPermissions: ['contacts', 'phone'],
    // 'location' is required ONLY when the user or profile asked to share it.
    conditionalPermissions: { shareLocation: ['location'] },
    requiresConfirmation: true, // FAST confirm — see EMERGENCY_CONFIRM_WINDOW_MS
    executedBy: 'client',
    phase: 3,
    riskLevel: 'high',
    notes:
      'Confirmation must be a 5s cancel window, never a multi-question dialogue.',
  },

  answer_call: {
    name: 'answer_call',
    description: 'Answer the incoming call.',
    params: {},
    requiredPermissions: ['phone'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 2,
    riskLevel: 'low',
  },

  reject_call: {
    name: 'reject_call',
    description: 'Reject or decline the incoming call.',
    params: {},
    requiredPermissions: ['phone'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 2,
    riskLevel: 'low',
  },

  end_call: {
    name: 'end_call',
    description: 'Hang up the call that is currently in progress.',
    params: {},
    requiredPermissions: ['phone'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 2,
    riskLevel: 'low',
  },

  // ---------------------------------------------------------- notifications
  read_notifications: {
    name: 'read_notifications',
    description:
      'Read out pending notifications or messages, optionally only from one app.',
    params: { appName: 'string', limit: 'number' },
    requiredPermissions: ['notifications'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 2,
    riskLevel: 'low',
  },

  reply_message: {
    name: 'reply_message',
    description: 'Send a reply to a message or to a person, dictated by voice.',
    params: { contactName: 'string', appName: 'string', message: 'string' },
    requiredPermissions: ['notifications'],
    // Addressing someone by name (rather than replying to a live notification)
    // additionally needs the contact list.
    conditionalPermissions: { contactName: ['contacts'] },
    requiresConfirmation: true, // a sent message cannot be unsent
    executedBy: 'client',
    phase: 2,
    riskLevel: 'high',
  },

  // --------------------------------------------------------------- language
  translate: {
    name: 'translate',
    description:
      'Translate some text into another language (Hindi, English, or a regional Indian language).',
    params: {
      text: 'string',
      targetLanguage: 'string',
      sourceLanguage: 'string',
    },
    requiredPermissions: [],
    requiresConfirmation: false,
    executedBy: 'server',
    phase: 1,
    riskLevel: 'none',
  },

  set_language: {
    name: 'set_language',
    description: 'Change the language ULTRON speaks and listens in.',
    params: { language: 'string' },
    requiredPermissions: [],
    requiresConfirmation: false,
    // Client-side: the app persists the preference via PATCH /api/device/:deviceId
    // and switches its own STT/TTS locale. The server only plans the change.
    executedBy: 'client',
    phase: 1,
    riskLevel: 'none',
  },

  // ------------------------------------------------------------ music/media
  play_music: {
    name: 'play_music',
    description: 'Play or resume music, optionally a named song or artist.',
    params: { query: 'string' },
    requiredPermissions: ['mediaControl'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 1,
    riskLevel: 'low',
  },

  pause_music: {
    name: 'pause_music',
    description: 'Pause or stop playback.',
    params: {},
    requiredPermissions: ['mediaControl'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 1,
    riskLevel: 'low',
  },

  next_track: {
    name: 'next_track',
    description: 'Skip to the next track.',
    params: {},
    requiredPermissions: ['mediaControl'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 1,
    riskLevel: 'low',
  },

  previous_track: {
    name: 'previous_track',
    description: 'Go back to the previous track.',
    params: {},
    requiredPermissions: ['mediaControl'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 1,
    riskLevel: 'low',
  },

  set_volume: {
    name: 'set_volume',
    description:
      'Change volume. direction is "up" or "down" for relative changes; level is 0-100 for absolute.',
    params: { level: 'number', direction: 'string' },
    requiredPermissions: ['mediaControl'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 1,
    riskLevel: 'low',
  },

  // ----------------------------------------------------------------- device
  set_noise_mode: {
    name: 'set_noise_mode',
    description:
      'Switch earbud noise control. mode is one of "anc", "transparency", "off".',
    params: { mode: 'string' },
    requiredPermissions: ['bluetooth'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 1,
    riskLevel: 'low',
  },

  device_status: {
    name: 'device_status',
    description:
      'Report earbud status: connection, noise mode, sound profile, battery.',
    params: {},
    requiredPermissions: ['bluetooth'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 1,
    riskLevel: 'none',
  },

  battery_status: {
    name: 'battery_status',
    description: 'Report the earbud or phone battery level.',
    params: {},
    requiredPermissions: ['bluetooth'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 1,
    riskLevel: 'none',
  },

  find_earbuds: {
    name: 'find_earbuds',
    description: 'Play a loud locate tone on the earbuds so they can be found.',
    params: {},
    requiredPermissions: ['bluetooth'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 1,
    riskLevel: 'low', // it makes a loud noise in someone's ear, so not risk-free
  },

  // ----------------------------------------------------------------- memory
  remember: {
    name: 'remember',
    description: 'Store a fact, note or reminder that the user wants kept.',
    params: { text: 'string' },
    requiredPermissions: [],
    requiresConfirmation: false,
    executedBy: 'server',
    phase: 1,
    riskLevel: 'none',
  },

  recall: {
    name: 'recall',
    description: 'Look up something the user asked ULTRON to remember earlier.',
    params: { query: 'string' },
    requiredPermissions: [],
    requiresConfirmation: false,
    executedBy: 'server',
    phase: 1,
    riskLevel: 'none',
  },

  // ------------------------------------------------------------- navigation
  navigate: {
    name: 'navigate',
    description: 'Start navigation to a destination.',
    params: { destination: 'string', mode: 'string' },
    requiredPermissions: ['location'],
    requiresConfirmation: true, // opens maps / starts a real-world journey
    executedBy: 'client',
    phase: 3,
    riskLevel: 'low',
  },

  // -------------------------------------------------------- vision (PHASE 4)
  // PLANNED CAPABILITY — NOT IMPLEMENTED. There is no camera or vision pipeline
  // in this backend. The orchestrator answers honestly that this is coming; it
  // must never pretend to have looked at anything.
  describe_scene: {
    name: 'describe_scene',
    description:
      'Describe what the camera is pointed at (planned capability, not yet available).',
    params: {},
    requiredPermissions: ['camera'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 4,
    riskLevel: 'low',
    implemented: false,
    notes: 'Phase 4 accessibility feature. No vision model is wired up yet.',
  },

  read_text: {
    name: 'read_text',
    description:
      'Read printed text in front of the user out loud (planned capability, not yet available).',
    params: {},
    requiredPermissions: ['camera'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 4,
    riskLevel: 'low',
    implemented: false,
    notes: 'Phase 4 accessibility feature. No OCR is wired up yet.',
  },

  // ----------------------------------------------------------------- safety
  safety_mode: {
    name: 'safety_mode',
    description:
      'Turn Safety Mode on or off (transparency and alerting while walking, cycling or driving).',
    params: { enabled: 'boolean' },
    requiredPermissions: ['microphone'],
    requiresConfirmation: false,
    executedBy: 'client',
    phase: 3,
    riskLevel: 'low',
    notes:
      'The Safety Mode FLAG is real and is persisted in the safety profile. The ' +
      'environmental sound classification behind it (horn / siren detection) is ' +
      'NOT implemented — it is a planned capability. Never tell a user that ' +
      'ULTRON is listening for sirens.',
  },

  // ----------------------------------------------------------- conversation
  ask_question: {
    name: 'ask_question',
    description: 'Answer a general knowledge or how-to question.',
    params: { question: 'string' },
    requiredPermissions: [],
    requiresConfirmation: false,
    executedBy: 'server',
    phase: 1,
    riskLevel: 'none',
  },

  smalltalk: {
    name: 'smalltalk',
    description: 'Greetings, thanks, chit-chat, or anything conversational.',
    params: {},
    requiredPermissions: [],
    requiresConfirmation: false,
    executedBy: 'server',
    phase: 1,
    riskLevel: 'none',
  },

  unknown: {
    name: 'unknown',
    description:
      'Use when the request matches no other intent or is too unclear to act on.',
    params: {},
    requiredPermissions: [],
    requiresConfirmation: false,
    executedBy: 'server',
    phase: 1,
    riskLevel: 'none',
  },
};

/** Canonical ordering — the mobile app relies on these exact strings. */
export const INTENT_NAMES = Object.keys(INTENT_REGISTRY);

/**
 * Look up one intent. Returns null (never throws) for anything unrecognised, so
 * a hallucinated intent name from the model degrades to "unknown" rather than
 * crashing a turn.
 */
export function getIntent(name) {
  if (!name || typeof name !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(INTENT_REGISTRY, name.trim())
    ? INTENT_REGISTRY[name.trim()]
    : null;
}

// The prompt block is deterministic, so build it once and reuse it: it is sent
// on every classification call, so every token here is paid for repeatedly.
let cachedPromptBlock = null;

/**
 * Render the registry as a compact block for the classifier prompt.
 * One line per intent:
 *   - name(param:type, ...) perms=a,b confirm=yes — description
 * Segments that do not apply are omitted entirely to save tokens.
 */
export function describeIntentsForPrompt() {
  if (cachedPromptBlock) return cachedPromptBlock;

  const lines = INTENT_NAMES.map((name) => {
    const intent = INTENT_REGISTRY[name];

    const params = Object.entries(intent.params || {})
      .map(([key, type]) => `${key}:${type}`)
      .join(', ');

    const parts = [`${name}(${params})`];

    const perms = intent.requiredPermissions || [];
    if (perms.length) parts.push(`perms=${perms.join(',')}`);
    if (intent.requiresConfirmation) parts.push('confirm=yes');
    if (intent.implemented === false) parts.push('status=planned');

    return `- ${parts.join(' ')} — ${intent.description}`;
  });

  cachedPromptBlock = lines.join('\n');
  return cachedPromptBlock;
}
