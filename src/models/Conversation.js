import mongoose from "mongoose";

/**
 * Rolling short-term conversation memory, one document per user.
 *
 * "Capped sensibly": this is NOT a Mongo capped collection (those forbid growing
 * documents). The cap is applied on write — store.conversations.append() trims
 * `turns` to MAX_TURNS so a single document can never grow unbounded, which
 * also keeps it far below the 16MB BSON limit.
 */

export const MAX_TURNS = 200;

const turnSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant", "system"],
      default: "user",
    },
    text: { type: String, default: "" },
    intent: { type: String, default: null }, // intent name resolved for this turn
    lang: { type: String, default: "hi-IN" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    turns: { type: [turnSchema], default: [] },
  },
  { timestamps: true }
);

// Belt and braces: even if a caller writes the array directly, never persist
// more than MAX_TURNS.
conversationSchema.pre("save", function trimTurns(next) {
  if (Array.isArray(this.turns) && this.turns.length > MAX_TURNS) {
    this.turns = this.turns.slice(-MAX_TURNS);
  }
  next();
});

export default mongoose.model("Conversation", conversationSchema);
