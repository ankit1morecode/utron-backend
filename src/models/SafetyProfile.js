import mongoose from "mongoose";

/**
 * Per-user safety configuration.
 *
 * !! SCOPE / HONESTY NOTE !!
 * `safetyMode` configures a PLANNED capability. Environmental sound
 * classification (recognising a horn, a siren, an alarm, a shout) is NOT
 * implemented anywhere in this backend. What exists today is:
 *   - the phone reporting raw loudness (dBFS) from its microphone metering, and
 *   - the user manually triggering safety actions.
 * Storing `enabled: true` therefore records a user PREFERENCE. It must never be
 * read as "the system is currently detecting sirens", and no reply text may
 * claim detection happened. `drivingMode` is likewise a preference set: the
 * phone decides and reports what it actually did.
 */

const emergencyContactSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    relation: { type: String, default: "", trim: true },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: false }
);

const trustedContactSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    relation: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const safetyModeSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    sensitivity: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    autoVolumeReduction: { type: Boolean, default: true },
    spokenWarnings: { type: Boolean, default: true },
    shareLocationOnEmergency: { type: Boolean, default: false },
  },
  { _id: false }
);

const drivingModeSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    autoDetect: { type: Boolean, default: false },
    announceCallers: { type: Boolean, default: true },
    announceImportantOnly: { type: Boolean, default: true },
  },
  { _id: false }
);

const safetyProfileSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    emergencyContacts: { type: [emergencyContactSchema], default: [] },
    trustedContacts: { type: [trustedContactSchema], default: [] },
    safetyMode: { type: safetyModeSchema, default: () => ({}) },
    drivingMode: { type: drivingModeSchema, default: () => ({}) },
  },
  { timestamps: true }
);

export default mongoose.model("SafetyProfile", safetyProfileSchema);
