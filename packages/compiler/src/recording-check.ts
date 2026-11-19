// Does the recording look like a good day's work? Hotpath repeats what the
// recorded agent did, so a sloppy recording becomes a sloppy workflow. These
// checks read the trace and the compiled workflow only (no model call) and
// say what looks wrong, for the owner to decide before trusting it.
import {
  numbersInText,
  type TraceFile,
  type Workflow,
} from "@hotpathrun/shared";

import { learnCalculations } from "./calculations.js";
import type { RecordedResult } from "./compiler.js";

const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v as object).length === 0);

/** An error that came back as an ordinary result ({error: "..."}, "Error: ..."). */
function errorText(v: unknown): string | null {
  if (typeof v === "string") {
    return /^\s*(error|exception|failed|denied|unauthori[sz]ed|forbidden)\b/i.test(
      v,
    )
      ? v
      : null;
  }
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of ["error", "errors", "error_message", "fault"]) {
      if (
        o[k] !== undefined &&
        o[k] !== null &&
        o[k] !== false &&
        !isEmpty(o[k])
      ) {
        return typeof o[k] === "string"
          ? (o[k] as string)
          : JSON.stringify(o[k]);
      }
    }
  }
  return null;
}

/** Lists found inside a value (the emails of {emails: [...]}). */
function lists(v: unknown, at: string, out: Array<[string, unknown[]]>) {
  if (Array.isArray(v)) out.push([at, v]);
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v))
      lists(x, at ? `${at}.${k}` : k, out);
  }
}

const short = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}...` : s);

export function recordingProblems(
  trace: TraceFile,
  workflow: Workflow,
  recorded: RecordedResult[],
): string[] {
  const out: string[] = [];
  const reads = trace.calls.filter((c) => {
    const tool = trace.meta.tools.find((t) => t.name === c.tool);
    return tool?.annotations?.readOnlyHint === true;
  });

  // tool errors and empty answers the agent built its text on
  for (const [i, c] of reads.entries()) {
    const err = c.isError ? JSON.stringify(c.result) : errorText(c.result);
    // the agent tried again and the tool answered (a retry after a 503, a
    // corrected argument): the compiler drops the failed call, nothing to say
    const recovered = reads
      .slice(i + 1)
      .some(
        (later) =>
          later.tool === c.tool && !later.isError && !errorText(later.result),
      );
    if (err && recovered) continue;
    if (err) {
      out.push(
        `${c.tool}(${short(JSON.stringify(c.args))}) answered with an error in the recording ("${short(err)}"). ` +
          "If the agent's text depends on it, record again when the tool works.",
      );
      continue;
    }
    if (isEmpty(c.result)) {
      out.push(
        `${c.tool}(${short(JSON.stringify(c.args))}) returned nothing in the recording, so the workflow learned ` +
          "nothing about its data. Record again on a day with data.",
      );
      continue;
    }
    const found: Array<[string, unknown[]]> = [];
    lists(c.result, "", found);
    const only = found.length === 1 ? found[0] : undefined;
    if (only && only[1].length === 0) {
      out.push(
        `${c.tool} returned an empty list${only[0] ? ` (${only[0]})` : ""} in the recording: ` +
          "the workflow cannot learn what a normal day's items look like. Record again on a day with items.",
      );
    }
  }

  // the same call over and over: the agent was retrying, or stuck
  let run = 1;
  for (let i = 1; i <= trace.calls.length; i++) {
    const a = trace.calls[i - 1]!;
    const b = trace.calls[i];
    const same =
      b !== undefined &&
      a.tool === b.tool &&
      JSON.stringify(a.args) === JSON.stringify(b.args);
    if (same) run++;
    else {
      if (run >= 3) {
        out.push(
          `the agent called ${a.tool}(${short(JSON.stringify(a.args))}) ${run} times in a row: it was retrying or stuck. ` +
            "Check the recording before relying on it.",
        );
      }
      run = 1;
    }
  }

  // figures in the text that no tool returned and no calculation explains
  const known = new Set<number>();
  const collect = (n: unknown) => {
    if (typeof n === "number") known.add(Math.abs(n));
    else if (Array.isArray(n)) n.forEach(collect);
    else if (n !== null && typeof n === "object")
      Object.values(n).forEach(collect);
  };
  for (const c of reads) {
    collect(c.result);
    collect(c.args);
  }
  collect(trace.meta.inputs);
  const haystack = JSON.stringify([
    reads.map((c) => [c.args, c.result]),
    trace.meta.inputs,
  ]);
  const ctx = {
    inputs: trace.meta.inputs as never,
    steps: {} as Record<string, never>,
  };
  for (const r of recorded) {
    ctx.steps[r.id] = (
      r.field === "results" ? { results: r.result } : { result: r.result }
    ) as never;
  }
  for (const step of workflow.steps) {
    if (step.type !== "llm") continue;
    const explained = new Set(
      learnCalculations(step.example, ctx)
        .filter((c) => c.op !== "time")
        .map((c) => Math.abs(c.recorded)),
    );
    const unexplained = [
      ...new Set(
        numbersInText(step.example)
          .map(Math.abs)
          .filter((n) => n >= 10 || !Number.isInteger(n))
          .filter((n) => !known.has(n) && !explained.has(n))
          // a number inside a returned string ("moved to 14:00") was returned too
          .filter((n) => !haystack.includes(String(n))),
      ),
    ];
    if (unexplained.length > 0) {
      out.push(
        `${step.id}: the recorded text has figures that no tool returned and Hotpath could not recompute ` +
          `(${unexplained.slice(0, 5).join(", ")}). Check them: a replay model will be asked to calculate figures like these.`,
      );
    }
  }
  return out;
}
