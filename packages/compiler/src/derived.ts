import type { Workflow } from "@hotpathrun/shared";

import type { RecordedResult } from "./compiler.js";

// A number written in a text: not part of an identifier (BK-1004) or a date.
const NUMBER = /(?<![\w.-])-?\d+(?:,\d{3})*(?:\.\d+)?(?![\w-])/g;
const DATE = /\d{4}-\d{2}-\d{2}/g;

export const CALCULATED = "<calculated>";

function numericLeaves(value: unknown, out: Set<number>): void {
  if (typeof value === "number") out.add(value);
  else if (Array.isArray(value)) value.forEach((v) => numericLeaves(v, out));
  else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((v) => numericLeaves(v, out));
  }
}

/**
 * Lines of the recorded text that hold a figure the agent calculated (a total,
 * a converted amount): a number that is in none of the data the step reads.
 * Returned with each such figure replaced by `<calculated>`, so the replay
 * prompt can say "write lines like these, with figures calculated from today's
 * data" without showing a number the model could copy.
 */
export function derivedLines(
  example: string,
  sources: unknown[],
  inputs: unknown,
): string[] {
  const haystack = JSON.stringify([sources, inputs]);
  const numbers = new Set<number>();
  numericLeaves(sources, numbers);
  numericLeaves(inputs, numbers);
  const out: string[] = [];
  for (const line of example.split("\n")) {
    let found = false;
    const template = line.replace(NUMBER, (token) => {
      if (line.includes(token) && DATE_TOKEN(line, token)) return token;
      const n = Number(token.replace(/,/g, ""));
      if (Number.isNaN(n) || numbers.has(n) || numbers.has(Math.abs(n))) {
        return token;
      }
      if (haystack.includes(token.replace(/^-/, ""))) return token;
      found = true;
      return CALCULATED;
    });
    if (found) out.push(template.trim());
  }
  return out;
}

/** The token is part of a date in the line (2026-10-01 gives 2026, 10, 01). */
function DATE_TOKEN(line: string, token: string): boolean {
  for (const d of line.matchAll(DATE)) if (d[0].includes(token)) return true;
  return false;
}

/** What the compile tells the owner about steps given to the stronger model. */
export function strongNotes(workflow: Workflow): string[] {
  return workflow.steps
    .filter((s) => s.type === "llm" && s.model === "strong")
    .map(
      (s) =>
        `${s.id}: the recorded text holds figures the agent calculated, so this step is written by the stronger model (HOTPATH_AGENT_MODEL), not the cheap one. ` +
        "It costs about 15 times more per run; leave HOTPATH_STRONG_CALC unset at compile time to use the cheap model.",
    );
}

/** Sets `derived` on every AI step whose recorded text holds calculated figures. */
export function markDerived(
  workflow: Workflow,
  recorded: RecordedResult[],
  inputs: unknown,
): Workflow {
  let changed = false;
  const steps = workflow.steps.map((s) => {
    if (s.type !== "llm") return s;
    const lines = derivedLines(
      s.example,
      recorded.map((r) => r.result),
      inputs,
    );
    if (lines.length === 0) return s;
    changed = true;
    // opt-in (HOTPATH_STRONG_CALC=1): once the retry kept the calculated-figures lines, the cheap model
    // wrote the total 3 of 3 times (measured), at a fifteenth of the stronger model's price
    return {
      ...s,
      derived: lines.slice(0, 8),
      ...(process.env.HOTPATH_STRONG_CALC === "1" ? { model: "strong" } : {}),
    };
  });
  return changed ? { ...workflow, steps } : workflow;
}
