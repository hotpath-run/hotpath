// Small open models (1–4B) often stop by writing their answer as a chat reply
// instead of calling the tool that does the job ("**Morning Brief** …" rather
// than send_message). The recording then lacks the action and the compiled
// workflow does nothing. When that happens we push back a couple of times,
// using the MCP read-only hints to know which tools count as acting.

export const MAX_NUDGES = 2;

/** Tools that change something: every tool not annotated readOnlyHint=true. */
export function actionToolNames(
  tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>,
): string[] {
  return tools
    .filter((t) => t.annotations?.readOnlyHint !== true)
    .map((t) => t.name);
}

/**
 * Splits one turn's calls: when reads and actions come together, the action
 * was planned before the model saw any data (qwen2.5-coder writes send_message
 * with "[Subject1, Subject2]" placeholders), so only the reads run now and the
 * model makes the action again next turn, with the results in front of it.
 */
export function deferActions<T extends { name: string }>(
  calls: T[],
  actionTools: readonly string[],
): { run: T[]; deferred: T[] } {
  const isAction = (c: T) => actionTools.includes(c.name);
  const reads = calls.filter((c) => !isAction(c));
  if (reads.length === 0 || reads.length === calls.length) {
    return { run: calls, deferred: [] };
  }
  return { run: reads, deferred: calls.filter(isAction) };
}

/**
 * The message to send back when the model replied in text, or null to accept
 * the reply as the end of the run.
 */
export function actionNudge(
  actionTools: readonly string[],
  calledTools: readonly string[],
  nudgesSoFar: number,
): string | null {
  if (actionTools.length === 0 || nudgesSoFar >= MAX_NUDGES) return null;
  if (calledTools.some((t) => actionTools.includes(t))) return null;
  return (
    "The task is not done: you replied in text, but nothing has been sent or " +
    `changed yet. Call the tool that completes the task (${actionTools.join(", ")}) ` +
    "now, putting your text in its arguments. Do not reply in plain text."
  );
}
