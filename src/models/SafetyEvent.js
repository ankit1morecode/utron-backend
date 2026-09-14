import mongoose from "mongoose";

/**
 * A logged safety-relevant audio/manual event.
 *
 * HONESTY NOTE: `detectedBy` records how the event actually arrived.
 *   - 'device_metering'    : the phone reported a raw loudness level (dBFS).
 *                            This says "it was loud", NOT "it was a siren".
 *   - 'manual'             : the user triggered it (button / voice command).
 *   - 'planned_classifier' : reserved for the not-yet-built environmental
 *                            sound classifier. Nothing writes this today.
 * `kind` values such as horn/siren are only trustworthy when a real classifier
 * produced them; with 'device_metering' expect 'loud_unknown'.
 * `action` records what the CLIENT reported doing — the server never assumes.
 */
const locationSchema = new mongoose.Schema(
  {
    lat: { type: Number },
    lng: { type: Number },
    accuracy: { type: Number },
  },
  { _id: false }
);

const safetyEventSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    kind: {
      type: String,
      enum: [
        "horn",
        "siren",
        "alarm",
        "shout",
        "loud_unknown",
        "manual_trigger",
        "emergency_call",
      ],
      default: "loud_unknown",
    },
    confidence: { type: Number, default: 0, min: 0, max: 1 },
    level: { type: Number }, // dBFS as measured by the device (negative values)
    action: {
      type: String,
      enum: ["none", "volume_reduced", "warned", "call_placed"],
      default: "none",
    },
    detectedBy: {
      type: String,
      enum: ["device_metering", "manual", "planned_classifier"],
      default: "device_metering",
    },
    location: { type: locationSchema, default: undefined }, // optional
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

safetyEventSchema.index({ userId: 1, at: -1 });

export default mongoose.model("SafetyEvent", safetyEventSchema);
