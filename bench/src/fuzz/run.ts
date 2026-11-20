// One fuzz case: record a generated task a few times, compile, replay on
// mutated data, and judge the outcome. The model is whatever `model` is set
// to (the fuzz test points chat() at fakeModel); nothing touches the network.

import { compileRecordings } from "@hotpathrun/compiler";
import { DriftError, runWorkflow, type ToolBackend } from "@hotpathrun/runtime";
import type { Workflow } from "@hotpathrun/shared";

import { model } from "./model.js";

import {
  answer,
  expectedEffects,
  fakeModel,
  int,
  KINDS,
  inputsOf,
  makeDataset,
  MUTATIONS,
  pick,
  record,
  rng,
  SIDE_EFFECTS,
  type Dataset,
  type Effect,
  type Kind,
  type Mutation,
  withLookup,
} from "./world.js";

/**
 * - ok: finished and did exactly what a correct run does
 * - stopped: drift, nothing wrong was done (safe; on "fresh" data a false stop)
 * - silent-wrong: finished, but its actions differ from a correct run (the worst)
 * - wrong-then-stopped: stopped after an action that a correct run would not make
 * - contradicts-recording: on a recording's own data it does something else (a sure bug)
 * - stops-on-own-recording: drift on data it was compiled from (a sure false stop)
 * - crash: an error that is not drift (a bug or a bad message)
 * - compile-crash: the compiler threw on valid recordings
 */
export type Outcome =
  | "ok"
  | "stopped"
  | "silent-wrong"
  | "wrong-then-stopped"
  | "contradicts-recording"
  | "stops-on-own-recording"
  | "crash"
  | "compile-crash";

export interface CaseResult {
  seed: number;
  kind: Kind;
  mutation: Mutation;
  recordings: number;
  outcome: Outcome;
  detail?: string;
  expected?: Effect[];
  actual?: Effect[];
  workflow?: string;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const shortWorkflow = (w: Workflow) =>
  w.steps
    .map((s) =>
      s.type === "tool"
        ? `${s.id} ${s.tool}(${JSON.stringify(s.args)})`
        : s.type === "foreach"
          ? `${s.id} foreach ${s.over} [${s.body.map((b) => b.id).join(",")}]`
          : `${s.id} ${s.type}`,
    )
    .join(" | ");

/** Picks the case for a seed: the kind, how many recordings, the replay data. */
export function plan(
  seed: number,
  only?: { kind?: Kind; mutation?: Mutation },
) {
  const r = rng(seed);
  const kind = only?.kind ?? pick(r, KINDS);
  const mutation = only?.mutation ?? pick(r, MUTATIONS);
  const n = int(r, 1, 3);
  const recordings: Dataset[] = [];
  for (let i = 0; i < n; i++) {
    // maybe-send needs a quiet day among its recordings to learn the branch
    const size = kind === "maybe-send" && i === 0 && n > 1 ? 0 : int(r, 1, 6);
    const ds = makeDataset(r, `2026-10-0${i + 1}`, size);
    recordings.push(kind === "lookup" ? withLookup(ds, i % 2 === 1, r) : ds);
  }
  const sizes = recordings.map((d) => d.items.length);
  const size =
    mutation === "longer"
      ? Math.max(...sizes) + int(r, 1, 4)
      : mutation === "shorter"
        ? 1
        : mutation === "empty"
          ? 0
          : int(
              r,
              Math.max(1, Math.min(...sizes)),
              Math.max(1, Math.max(...sizes)),
            );
  const fresh = makeDataset(r, "2026-10-09", size, mutation);
  const replay = kind === "lookup" ? withLookup(fresh, r() < 0.5, r) : fresh;
  const noise = r() < 0.2;
  return { r, kind, mutation, recordings, replay, noise };
}

export async function runCase(
  seed: number,
  only?: { kind?: Kind; mutation?: Mutation },
): Promise<CaseResult> {
  const { r, kind, mutation, recordings, replay, noise } = plan(seed, only);
  const base = { seed, kind, mutation, recordings: recordings.length };

  let workflow: Workflow;
  const traces = recordings.map((ds, i) =>
    record(kind, ds, r, noise && i === 0),
  );
  try {
    workflow = compileRecordings(traces, "fuzz").workflow;
  } catch (err) {
    return { ...base, outcome: "compile-crash", detail: String(err) };
  }

  const shown = shortWorkflow(workflow);

  // 1. On its own recordings' data, the workflow must do what each recording did.
  for (const [i, ds] of recordings.entries()) {
    const want = traces[i]!.calls.filter((c) => SIDE_EFFECTS.has(c.tool)).map(
      (c) => ({ tool: c.tool, args: c.args }),
    );
    const got = await replayOn(workflow, kind, ds);
    if (got.error || !same(got.effects, want)) {
      return {
        ...base,
        outcome: got.drift
          ? "stops-on-own-recording"
          : got.error
            ? "crash"
            : "contradicts-recording",
        detail: `recording ${i + 1}${got.error ? `: ${got.error}` : ""}`,
        expected: want,
        actual: got.effects,
        workflow: shown,
      };
    }
  }

  // 2. On new, possibly changed data: right, or a clean stop.
  const expected = expectedEffects(kind, replay, rng(seed + 1));
  const got = await replayOn(workflow, kind, replay);
  if (got.drift) {
    const wrong = got.effects.some((a) => !expected.some((e) => same(a, e)));
    return {
      ...base,
      outcome: wrong ? "wrong-then-stopped" : "stopped",
      detail: got.error,
      expected,
      actual: got.effects,
      workflow: shown,
    };
  }
  if (got.error)
    return { ...base, outcome: "crash", detail: got.error, workflow: shown };
  return same(got.effects, expected)
    ? { ...base, outcome: "ok" }
    : {
        ...base,
        outcome: "silent-wrong",
        expected,
        actual: got.effects,
        workflow: shown,
      };
}

/** Replays the workflow on one dataset; returns the side effects it made. */
async function replayOn(
  workflow: Workflow,
  kind: Kind,
  ds: Dataset,
): Promise<{ effects: Effect[]; drift?: boolean; error?: string }> {
  const effects: Effect[] = [];
  const tools: ToolBackend = {
    async call(tool, args) {
      if (SIDE_EFFECTS.has(tool)) effects.push({ tool, args });
      return answer(ds, tool, args);
    },
  };
  model.answer = (prompt) => fakeModel(kind, ds, prompt);
  try {
    await runWorkflow(workflow, {
      inputs: inputsOf(ds),
      noFallback: true,
      reuse: false,
      repairMentions: false,
      tools,
    });
    return { effects };
  } catch (err) {
    if (err instanceof DriftError)
      return { effects, drift: true, error: err.message };
    return {
      effects,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}
