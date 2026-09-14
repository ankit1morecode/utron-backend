import mongoose from "mongoose";

/**
 * A single durable memory item ("remember that my flight is on Friday").
 * `kind` lets the recall layer bias results (a `person` beats a `fact` when
 * the query looks like a name).
 */
const memorySchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    text: { type: String, required: true, trim: true },
    kind: {
      type: String,
      enum: ["fact", "preference", "person", "place", "reminder"],
      default: "fact",
    },
    tags: { type: [String], default: [] },
    source: {
      type: String,
      enum: ["voice", "app", "auto"],
      default: "voice",
    },
  },
  { timestamps: true }
);

// Full-text search for memories.recall(). Mongo allows exactly one text index
// per collection, so 'text' is the only field in it.
memorySchema.index({ text: "text" });

// Newest-first listing per user is the hot path for memories.list().
memorySchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model("Memory", memorySchema);
