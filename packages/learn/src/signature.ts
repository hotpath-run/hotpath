// A path signature says what a run did without the data it did it on: the
// tools in order, which change something, and where each argument came from.
// Two runs of the same job on different days share it; so do 3 pages and 5,
// or a loop over 2 items and over 4 (the compiler turns both into one step).
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { TraceFile, TraceToolCall } from "@hotpathrun/shared";

/**
 * Where an argument comes from:
 * - value: a short value the agent chose (a date, a name): an input or a constant
 * - result: a value an earlier tool returned (a ref, an id)
 * - page: a page number of a paginated read
 * - text: text the agent wrote (the message it sends)
 * - data: a list or object nothing earlier returned
 */
export type ArgKind = "value" | "result" | "page" | "text" | "data";

export interface PathCall {
  tool: string;
  sideEffect: boolean;
  args: Record<string, unknown>;
  kinds: Record<string, ArgKind>;
  /** the same call made once per item (a loop) */
  repeated: boolean;
  /** the recorded calls this one stands for */
  calls: TraceToolCall[];
}

export interface PathSignature {
  /** "path-" and 8 hex characters of the key: a name for the path */
  id: string;
  key: string;
  steps: string[];
  calls: PathCall[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Text the agent wrote, not a value it picked: long, or on several lines. */
const isText = (v: unknown) =>
  typeof v === "string" && (v.length > 120 || v.includes("\n"));

function scalars(v: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(v)) for (const x of v) scalars(x, out);
  else if (isObject(v)) for (const x of Object.values(v)) scalars(x, out);
  else if (v !== null && v !== undefined && v !== "")
    out.add(JSON.stringify(v));
  return out;
}

/** A page-number argument: the result names the next page (or none, the last). */
function pageArg(call: TraceToolCall): string | null {
  if (!isObject(call.result)) return null;
  for (const [arg, page] of Object.entries(call.args)) {
    if (typeof page !== "number" || !Number.isInteger(page)) continue;
    const next = Object.entries(call.result).find(
      ([k, v]) => /^next/i.test(k) && (v === page + 1 || v === null),
    );
    if (next) return arg;
  }
  return null;
}

/** The pages after `first` of one read: same tool and arguments, page plus one. */
function laterPages(
  calls: TraceToolCall[],
  start: number,
  arg: string,
  readOnly: (tool: string) => boolean,
): number[] {
  const out: number[] = [];
  let prev = calls[start]!;
  for (let k = start + 1; k < calls.length; k++) {
    const c = calls[k]!;
    if (!readOnly(c.tool)) break; // a side effect ends the read
    const same =
      c.tool === prev.tool &&
      c.args[arg] === (prev.args[arg] as number) + 1 &&
      Object.keys(c.args).length === Object.keys(prev.args).length &&
      Object.keys(prev.args).every(
        (key) => key === arg || isDeepStrictEqual(prev.args[key], c.args[key]),
      );
    if (same) {
      out.push(k);
      prev = c;
    }
  }
  return out;
}

/** The run's successful calls with pages merged and loops folded, each argument typed. */
export function pathCalls(trace: TraceFile): PathCall[] {
  const readOnly = (tool: string) =>
    trace.meta.tools.find((t) => t.name === tool)?.annotations?.readOnlyHint ===
    true;
  // a failed call the agent made again is a retry, not a step; one it never
  // retried stays, so the failed run counts against its own path
  const ok = trace.calls.filter(
    (c, i) =>
      !c.isError ||
      !trace.calls
        .slice(i + 1)
        .some((later) => later.tool === c.tool && !later.isError),
  );
  const merged: Array<{
    call: TraceToolCall;
    page: string | null;
    all: TraceToolCall[];
  }> = [];
  const taken = new Set<number>();
  ok.forEach((call, i) => {
    if (taken.has(i)) return;
    const page = readOnly(call.tool) ? pageArg(call) : null;
    const rest = page ? laterPages(ok, i, page, readOnly) : [];
    for (const k of rest) taken.add(k);
    merged.push({ call, page, all: [call, ...rest.map((k) => ok[k]!)] });
  });

  const argValues = new Set<string>();
  const resultValues = new Set<string>();
  const typed: PathCall[] = merged.map(({ call, page, all }) => {
    const kinds: Record<string, ArgKind> = {};
    for (const [arg, value] of Object.entries(call.args)) {
      const key = JSON.stringify(value);
      kinds[arg] =
        arg === page
          ? "page"
          : isText(value)
            ? "text"
            : // a value the agent already passed is the same input again,
              // even when an earlier result happens to repeat it
              argValues.has(key)
              ? "value"
              : resultValues.has(key)
                ? "result"
                : isObject(value) || Array.isArray(value)
                  ? "data"
                  : "value";
    }
    for (const value of Object.values(call.args)) {
      if (!isText(value)) argValues.add(JSON.stringify(value));
    }
    for (const c of all) if (!c.isError) scalars(c.result, resultValues);
    return {
      tool: call.tool,
      sideEffect: !readOnly(call.tool),
      args: call.args,
      kinds,
      repeated: false,
      calls: all,
    };
  });

  // one call per item of an earlier list: a loop, however many items
  const folded: PathCall[] = [];
  for (const call of typed) {
    const prev = folded[folded.length - 1];
    const perItem = Object.values(call.kinds).includes("result");
    if (prev && perItem && stepText(prev) === stepText(call)) {
      prev.repeated = true;
      prev.calls.push(...call.calls);
    } else {
      folded.push(call);
    }
  }
  return folded;
}

/** `tool!(arg:kind, …)`, with `*` when it can run once per item of an earlier list. */
function stepText(call: PathCall): string {
  const args = Object.keys(call.kinds)
    .sort()
    .map((k) => `${k}:${call.kinds[k]}`)
    .join(", ");
  const perItem = Object.values(call.kinds).includes("result");
  return `${call.tool}${call.sideEffect ? "!" : ""}(${args})${perItem ? "*" : ""}`;
}

export function pathSignature(trace: TraceFile): PathSignature {
  const calls = pathCalls(trace);
  // a call made for one item and the same call made for five read alike
  const steps = calls.map(stepText);
  const key = steps.join(" → ");
  const id = `path-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
  return { id, key, steps, calls };
}
