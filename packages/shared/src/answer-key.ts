import { createHash } from "node:crypto";

/**
 * Identifies one llm step's question: its recorded example (which changes on
 * every recompile) plus the data it is given. The same key means the same
 * question, so the earlier answer is still right and no model call is needed.
 */
export function answerKey(example: string, dataPrompt: string): string {
  return createHash("sha256")
    .update(example)
    .update("\u0000")
    .update(dataPrompt)
    .digest("hex");
}
