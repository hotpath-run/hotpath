// A hot path is compiled with the compiler everyone uses, from all its clean
// runs at once, under the path's name and with the inputs worked out across
// them. The result is a candidate: it goes live only after a shadow check.
import { isDeepStrictEqual } from "node:util";

import { compileRecordings, MAX_RECORDINGS } from "@hotpathrun/compiler";
import { traceBackend, runWorkflow, DriftError } from "@hotpathrun/runtime";
import type { TraceFile, Workflow } from "@hotpathrun/shared";

import { inferInputs } from "./inputs.js";
import type { PathGroup } from "./paths.js";

export interface Candidate {
  workflow: Workflow;
  warnings: string[];
  /** the inputs of the newest run (the shadow check replays on them) */
  inputs: Record<string, unknown>;
  /** how many runs the workflow was compiled from */
  fromRuns: number;
}

export interface CandidateOptions {
  /**
   * Compile the newest clean run alone (inputs are still worked out across
   * all of them). For runs whose texts disagree: the compiler asks a replay
   * to mention what any recording mentioned, while its example text is the
   * newest one's, so the candidate can fail its own checks.
   */
  newestOnly?: boolean;
}

/** The trace as if the user had labelled it: the path's name, the inferred inputs. */
function labelled(
  run: TraceFile,
  task: string,
  inputs: Record<string, unknown>,
): TraceFile {
  return { ...run, meta: { ...run.meta, task, inputs } };
}

export function compileCandidate(
  group: PathGroup,
  options: CandidateOptions = {},
): Candidate {
  const clean = group.runs
    .filter((_, i) => group.health[i]!.clean)
    .slice(-MAX_RECORDINGS);
  if (clean.length === 0) {
    throw new Error(
      `${group.id} has no clean run to compile: run the task again`,
    );
  }
  const { inputs, perRun } = inferInputs(clean);
  const all = clean.map((run, i) => labelled(run, group.id, perRun[i]!));
  const traces = options.newestOnly ? all.slice(-1) : all;
  const compiled = compileRecordings(
    traces,
    `hotpath learn: ${traces.length} run${traces.length === 1 ? "" : "s"} of ${group.id}`,
  );
  // the compiler names inputs from the newest run; keep the inferred types
  const workflow: Workflow = {
    ...compiled.workflow,
    inputs: {
      ...compiled.workflow.inputs,
      ...pick(inputs, compiled.workflow.inputs),
    },
  };
  return {
    workflow,
    warnings: compiled.warnings,
    inputs: perRun[perRun.length - 1]!,
    fromRuns: traces.length,
  };
}

function pick<T>(
  from: Record<string, T>,
  keys: Record<string, unknown>,
): Record<string, T> {
  return Object.fromEntries(Object.entries(from).filter(([k]) => k in keys));
}

export interface ShadowCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ShadowResult {
  ok: boolean;
  problems: string[];
  /** what the replay would have sent, written or deleted */
  sideEffects: ShadowCall[];
}

/**
 * Replay `workflow` on the run's own data with no model and no real tool:
 * reads answer from the recording, side effects are caught, never made. It
 * passes when the replay makes the very side-effect calls the agent made.
 */
export async function shadowCheck(
  workflow: Workflow,
  run: TraceFile,
  inputs?: Record<string, unknown>,
): Promise<ShadowResult> {
  const readOnly = (tool: string) =>
    run.meta.tools.find((t) => t.name === tool)?.annotations?.readOnlyHint ===
    true;
  const reads = traceBackend(run);
  const sideEffects: ShadowCall[] = [];
  const agentActs = run.calls
    .filter((c) => !c.isError && !readOnly(c.tool))
    .map((c) => ({ tool: c.tool, args: c.args, result: c.result }));
  const tools = {
    async call(tool: string, args: Record<string, unknown>) {
      if (readOnly(tool)) return reads.call(tool, args);
      sideEffects.push({ tool, args });
      // answer as the real tool did for the agent; nothing leaves this process
      const same = agentActs.find(
        (a) => a.tool === tool && isDeepStrictEqual(a.args, args),
      );
      return { value: same?.result ?? { ok: true }, isError: false };
    },
  };
  const given = inputs ?? fromWorkflowExamples(workflow);
  const problems: string[] = [];
  const log = console.log;
  const journal = process.env.HOTPATH_JOURNAL;
  console.log = () => {}; // the replay's progress lines are noise here
  // the shadow backend never acts, so there is nothing to journal
  process.env.HOTPATH_JOURNAL = "0";
  try {
    await runWorkflow(workflow, {
      inputs: Object.fromEntries(
        Object.entries(given).map(([k, v]) => [k, String(v)]),
      ),
      tools,
      offline: true,
      reuse: true,
      noFallback: true,
    });
  } catch (err) {
    if (err instanceof DriftError)
      problems.push(`${err.stepId}: ${err.reason}`);
    else problems.push(err instanceof Error ? err.message : String(err));
  } finally {
    console.log = log;
    if (journal === undefined) delete process.env.HOTPATH_JOURNAL;
    else process.env.HOTPATH_JOURNAL = journal;
  }
  for (const call of reads.unmatched) {
    problems.push(`the replay reads ${call}, which the agent never did`);
  }
  problems.push(...compareActions(sideEffects, agentActs));
  return { ok: problems.length === 0, problems, sideEffects };
}

function compareActions(replay: ShadowCall[], agent: ShadowCall[]): string[] {
  const out: string[] = [];
  const n = Math.max(replay.length, agent.length);
  for (let i = 0; i < n; i++) {
    const r = replay[i];
    const a = agent[i];
    if (r && a && r.tool === a.tool && isDeepStrictEqual(r.args, a.args))
      continue;
    out.push(
      !r
        ? `the agent called ${a!.tool}, the replay did not`
        : !a
          ? `the replay calls ${r.tool}, which the agent did not`
          : `the replay calls ${r.tool}(${short(r.args)}) where the agent called ${a.tool}(${short(a.args)})`,
    );
  }
  return out;
}

function short(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

function fromWorkflowExamples(workflow: Workflow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(workflow.inputs).map(([k, v]) => [k, v.example]),
  );
}
