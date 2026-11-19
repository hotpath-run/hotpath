// Step 7 of the v1 brief: before a compiled workflow is trusted, replay it
// once on the data it was recorded from. Tools answer from the trace, no model
// is asked (the recorded text is reused when it passes the workflow's checks),
// side effects are dry runs. What can go wrong shows up here first: a tool
// step that asks for something the recording never asked (a template that
// picks the wrong value), or a recorded text that fails its own checks.
import { isDeepStrictEqual } from "node:util";

import type { TraceFile, Workflow } from "@hotpathrun/shared";

import { DriftError, runWorkflow, type ToolBackend } from "./runtime.js";

/** Answers each call with the recorded result of the same tool and arguments. */
export function traceBackend(trace: TraceFile): ToolBackend & {
  unmatched: string[];
} {
  const unmatched: string[] = [];
  return {
    unmatched,
    async call(tool, args) {
      const hit = trace.calls.find(
        (c) => c.tool === tool && isDeepStrictEqual(c.args, args) && !c.isError,
      );
      if (hit) return { value: hit.result, isError: false };
      unmatched.push(`${tool}(${JSON.stringify(args)})`);
      return { value: "not in the recording", isError: true };
    },
  };
}

/** Problems found replaying `workflow` on `trace`; [] when it reproduces the recording. */
export async function verifyOnRecording(
  workflow: Workflow,
  trace: TraceFile,
): Promise<string[]> {
  const tools = traceBackend(trace);
  const inputs = Object.fromEntries(
    Object.entries(trace.meta.inputs ?? {}).map(([k, v]) => [k, String(v)]),
  );
  const problems: string[] = [];
  const log = console.log;
  console.log = () => {}; // the replay's own progress lines are noise here
  try {
    await runWorkflow(workflow, {
      inputs,
      tools,
      dryRun: true,
      offline: true,
      reuse: true,
    });
  } catch (err) {
    if (!(err instanceof DriftError)) throw err;
    problems.push(`${err.stepId}: ${err.reason}`);
  } finally {
    console.log = log;
  }
  for (const call of tools.unmatched) {
    problems.push(
      `the workflow calls ${call}, which the recording never did: a step's arguments do not come out as recorded`,
    );
  }
  return problems;
}
