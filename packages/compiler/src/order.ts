// Write every text before the first action, where the data allows it.
//
// An agent often writes, sends, writes, sends (two-places: a handoff to
// on-call, then a status-page note). Replayed in that order, a guard that
// rejects the second text stops the run after the first message went out: the
// agent cannot take over (it would send it twice) and the run ends half done.
// Measured 2026-11-18 on qwen3:1.7b: 3 of 10 two-places replays ended so. An AI
// step that reads nothing an action returned can run before that action; then
// every check happens before anything is sent.
import type { Workflow, WorkflowStep } from "@hotpathrun/shared";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does the step's text (prompt, args, conditions) read `steps.<id>`? */
function reads(step: WorkflowStep, id: string): boolean {
  return new RegExp(`steps\\.${escapeRegExp(id)}(?![\\w-])`).test(
    JSON.stringify(step),
  );
}

const movableAction = (s: WorkflowStep) =>
  s.type === "tool" && s.sideEffect && !("when" in s && s.when);

export function writeBeforeActing(workflow: Workflow): Workflow {
  // HOTPATH_WRITE_FIRST=0 keeps the recorded order (to measure the difference)
  if (process.env.HOTPATH_WRITE_FIRST === "0") return workflow;
  const steps = [...workflow.steps];
  let moved = false;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.type !== "llm" || ("when" in step && step.when)) continue;
    let j = i;
    while (
      j > 0 &&
      movableAction(steps[j - 1]!) &&
      !reads(step, steps[j - 1]!.id)
    ) {
      steps[j] = steps[j - 1]!;
      steps[j - 1] = step;
      j--;
      moved = true;
    }
  }
  return moved ? { ...workflow, steps } : workflow;
}
