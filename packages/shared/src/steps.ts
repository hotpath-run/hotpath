import type {
  CaseStep,
  Condition,
  LlmStep,
  ToolStep,
  WorkflowStep,
} from "./schemas.js";

/** The steps a branch can run, all cases and `else` together. */
function inside(step: WorkflowStep | CaseStep): CaseStep[] {
  return step.type === "branch"
    ? [...step.cases.flatMap((c) => c.steps), ...(step.else ?? [])]
    : [];
}

/**
 * Every tool step in order: loop bodies and the steps inside branch cases
 * included. For checks that ask "does this workflow call X", where it does not
 * matter on which path.
 */
export function toolStepsOf(steps: Array<WorkflowStep | CaseStep>): ToolStep[] {
  return steps.flatMap((s): ToolStep[] =>
    s.type === "tool"
      ? [s]
      : s.type === "foreach"
        ? s.body
        : s.type === "branch"
          ? toolStepsOf(inside(s))
          : [],
  );
}

/** Every AI step in order, including those inside branch cases. */
export function llmStepsOf(steps: Array<WorkflowStep | CaseStep>): LlmStep[] {
  return steps.flatMap((s): LlmStep[] =>
    s.type === "llm" ? [s] : s.type === "branch" ? llmStepsOf(inside(s)) : [],
  );
}

/** A step's condition in words ("steps.s1.result.emails is not empty"). */
export function whenText(when: Condition): string {
  switch (when.kind) {
    case "nonEmpty":
      return `${when.ref} is not empty`;
    case "empty":
      return `${when.ref} is empty`;
    case "equals":
      return `${when.ref} is ${JSON.stringify(when.value)}`;
    case "notEquals":
      return `${when.ref} is not ${JSON.stringify(when.value)}`;
    case "ask":
      return "the replay model says yes (no rule told the recordings apart)";
  }
}
