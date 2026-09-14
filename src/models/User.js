import mongoose from "mongoose";

/**
 * Per-device user profile. `deviceId` is the identity everywhere in the system
 * (the earbuds' paired phone id) — there are no accounts or passwords.
 *
 * Every sub-document uses _id:false: these are settings blobs the mobile app
 * PATCHes wholesale, not collections it addresses by id.
 */

const wakeWordSchema = new mongoose.Schema(
  {
    phrase: { type: String, default: "Ultron", trim: true },
    enabled: { type: Boolean, default: true },
    sensitivity: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
  },
  { _id: false }
);

const voiceSchema = new mongoose.Schema(
  {
    speaker: { type: String, default: "priya" }, // Sarvam bulbul:v3 speaker id
    rate: { type: Number, default: 1, min: 0.3, max: 3 },
    pitch: { type: Number, default: 0, min: -10, max: 10 },
  },
  { _id: false }
);

// How a notification category should be handled when it arrives.
const notificationRuleSchema = new mongoose.Schema(
  {
    category: { type: String, required: true }, // e.g. 'whatsapp', 'calls', 'email'
    read: { type: Boolean, default: true }, // read it aloud?
    importance: {
      type: String,
      enum: ["low", "normal", "high"],
      default: "normal",
    },
  },
  { _id: false }
);

// Physical touch gestures on the buds -> an intent name from INTENT_NAMES.
const touchMappingSchema = new mongoose.Schema(
  {
    side: { type: String, enum: ["left", "right"], default: "right" },
    gesture: {
      type: String,
      enum: ["single", "double", "triple", "hold"],
      default: "single",
    },
    action: { type: String, default: "play_music" }, // intent name
  },
  { _id: false }
);

/**
 * Privacy gates. Everything the app could read about the user defaults to OFF
 * — the user must opt in per capability. storeConversations is the one
 * exception (on by default) because session memory is the core feature; the
 * user can still turn it off, and the store honours it.
 */
const privacySchema = new mongoose.Schema(
  {
    allowContacts: { type: Boolean, default: false },
    allowNotifications: { type: Boolean, default: false },
    allowLocation: { type: Boolean, default: false },
    allowCamera: { type: Boolean, default: false },
    storeConversations: { type: Boolean, default: true },
  },
  { _id: false }
);

const offlineSchema = new mongoose.Schema(
  {
    // When true the phone may run a small set of commands (volume, pause,
    // next track) locally with no backend round-trip.
    allowLocalCommands: { type: Boolean, default: true },
  },
  { _id: false }
);

const accessibilitySchema = new mongoose.Schema(
  {
    voiceFirst: { type: Boolean, default: true },
    spokenNotifications: { type: Boolean, default: true },
    spokenCallers: { type: Boolean, default: true },
    verboseDescriptions: { type: Boolean, default: false },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, unique: true },
    preferredLanguage: { type: String, default: "hi-IN" },
    soundProfile: { type: String, default: "balanced" },
    noiseControl: { type: String, default: "off" }, // off | anc | transparency

    wakeWord: { type: wakeWordSchema, default: () => ({}) },
    voice: { type: voiceSchema, default: () => ({}) },
    responseStyle: {
      type: String,
      enum: ["concise", "balanced", "detailed"],
      default: "balanced",
    },
    notificationRules: { type: [notificationRuleSchema], default: [] },
    touchMappings: { type: [touchMappingSchema], default: [] },
    privacy: { type: privacySchema, default: () => ({}) },
    offline: { type: offlineSchema, default: () => ({}) },
    accessibility: { type: accessibilitySchema, default: () => ({}) },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);
