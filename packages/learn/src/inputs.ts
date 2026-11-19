// Nobody told hotpath what this job's inputs are. Across the runs of one
// path, a value the agent picked that changes from run to run (today's date)
// is an input; one that never changes ("Paris", to "me") is a constant the
// compiler keeps as written. Values read from an earlier result, page numbers
// and the text the agent wrote are neither: the compiler wires those itself.
import { isDeepStrictEqual } from "node:util";

import type { TraceFile, WorkflowInput } from "@hotpathrun/shared";

import { pathCalls } from "./signature.js";

export interface InferredInputs {
  inputs: Record<string, WorkflowInput>;
  /** each run's value of every input, in the order of the runs given */
  perRun: Array<Record<string, unknown>>;
}

const typeOf = (v: unknown) =>
  Array.isArray(v) ? "array" : v === null ? "null" : typeof v;

/** Runs must share a path signature (see pathSignature); the newest is last. */
export function inferInputs(runs: TraceFile[]): InferredInputs {
  const calls = runs.map(pathCalls);
  const steps = Math.min(...calls.map((c) => c.length));
  // one input per distinct series of values: get_emails(date) and
  // get_calendar(date) that always agree are the same input
  const found: Array<{ name: string; values: unknown[] }> = [];
  for (let i = 0; i < steps; i++) {
    const first = calls[0]![i]!;
    for (const arg of Object.keys(first.kinds).sort()) {
      if (calls.some((c) => c[i]!.kinds[arg] !== "value")) continue;
      const values = calls.map((c) => c[i]!.args[arg]);
      if (values.every((v) => isDeepStrictEqual(v, values[0]))) continue;
      if (found.some((f) => isDeepStrictEqual(f.values, values))) continue;
      found.push({ name: freeName(arg, found), values });
    }
  }
  const newest = runs.length - 1;
  return {
    inputs: Object.fromEntries(
      found.map((f) => [
        f.name,
        { type: typeOf(f.values[newest]), example: f.values[newest] },
      ]),
    ),
    perRun: runs.map((_, r) =>
      Object.fromEntries(found.map((f) => [f.name, f.values[r]])),
    ),
  };
}

/** `date`, then `date_2`, `date_3`… for different values under the same name. */
function freeName(arg: string, taken: Array<{ name: string }>): string {
  // input names become --flags (see INPUT_NAME_RE in the runtime)
  const base = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(arg) ? arg : "input";
  let name = base;
  for (let n = 2; taken.some((t) => t.name === name); n++)
    name = `${base}_${n}`;
  return name;
}
