// Helpers of `bench:rejections`: was a rejected replay answer really wrong?
//
// A guard rejection is "false" when the text it rejected was a correct report
// by the benchmark's own definition (every expected mention, and the exact
// checks where the task has them). Otherwise it is "true": the guard stopped a
// report that was wrong. Provider errors (429, 503, timeouts) are neither: the
// model never answered, so they say nothing about the guards.
import { missingMentions } from "./lib.js";
import { correctnessProblems, type Exact } from "./measure-lib.js";

export interface MeasuredRun {
  seq: number;
  task: string;
  scenario: string;
  ok: boolean;
  driftStep?: string;
  driftReason?: string;
  outputTail?: string;
  providerError?: boolean;
  reason?: string;
  firstAttemptIssues?: string[];
  rejectedOutputs?: string[];
  sent: string;
  mentionsMissing: string[];
  correctnessProblems: string[] | "not defined";
}

export interface Expectation {
  mustMention: string[];
  exact?: Exact;
}

export type Verdict =
  | "finished-correct"
  | "finished-wrong"
  | "true-rejection"
  | "false-rejection"
  | "provider-error"
  | "unknown";

/** Which guard a drift reason names, in a few words. */
export function guardOf(reason: string): string {
  if (/grounding guard|does not mention/.test(reason)) return "grounding";
  if (/stale-fact guard|repeats facts/.test(reason)) return "stale-fact";
  if (/maxChars/.test(reason)) return "length";
  if (/nonEmpty|is empty/.test(reason)) return "non-empty";
  if (/token cap/.test(reason)) return "token cap";
  if (/returned an error/.test(reason)) return "tool error";
  if (/must have|must be|schema|required property/.test(reason)) {
    return "schema";
  }
  return "other";
}

/** A model provider failed (no answer to judge), not a guard. */
export function isProviderError(text: string): boolean {
  return /\b(429|500|502|503|504)\b|rate.?limit|overloaded|ECONNRESET|ETIMEDOUT|fetch failed|Connection error|quota/i.test(
    text,
  );
}

/** Problems of a text as a report; [] means a correct one. */
export function reportProblems(text: string, expected: Expectation): string[] {
  const missing = missingMentions(text, expected.mustMention).map(
    (m) => `does not mention ${m}`,
  );
  const exact = expected.exact ? correctnessProblems(text, expected.exact) : [];
  return [...missing, ...exact];
}

export function verdictOf(run: MeasuredRun, expected: Expectation): Verdict {
  if (run.ok) {
    const wrong =
      run.mentionsMissing.length > 0 ||
      (Array.isArray(run.correctnessProblems) &&
        run.correctnessProblems.length > 0);
    return wrong ? "finished-wrong" : "finished-correct";
  }
  const why = `${run.reason ?? ""} ${run.driftReason ?? ""} ${run.outputTail ?? ""}`;
  if (run.providerError) return "provider-error";
  if (!run.reason && isProviderError(why)) return "provider-error";
  const last = run.rejectedOutputs?.at(-1);
  if (last === undefined)
    return isProviderError(why) ? "provider-error" : "unknown";
  return reportProblems(last, expected).length === 0
    ? "false-rejection"
    : "true-rejection";
}

/**
 * The model provider failed (a 429 from the model API, a 5xx, a dropped
 * connection), as opposed to a tool that answered with an error (flaky-sales'
 * 503 is a tool error the engine must handle) or a guard that stopped a run.
 */
export function isModelProviderFailure(text: string): boolean {
  if (/drift at|returned an error|guard/i.test(text)) return false;
  return isProviderError(text);
}

/**
 * The fallback agent's own model call failed at the provider ("demo-agent: 503
 * status code"), after the replay drifted. The recovery was not measured: the
 * provider was down, not the engine.
 */
export function agentProviderFailure(output: string): boolean {
  return output
    .split("\n")
    .some((l) => /^\s*demo-agent:/.test(l) && isProviderError(l));
}
