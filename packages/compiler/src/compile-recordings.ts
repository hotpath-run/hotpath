import {
  workflowSchema,
  type TraceFile,
  type Workflow,
} from "@hotpathrun/shared";

import { compileTraces } from "./branches.js";
import { markCalculations } from "./calculations.js";
import { recordingWarnings } from "./compile-task.js";
import { applyRequirements, markSelective } from "./coverage.js";
import { markDerived } from "./derived.js";
import { recordingProblems } from "./recording-check.js";

/**
 * Compile several recordings held in memory, with no files read or written:
 * `hotpath learn` (packages/learn) groups runs nobody labelled and compiles
 * each group at once. The same passes as compileRecording, over all of them.
 */
export function compileRecordings(
  traces: TraceFile[],
  compiledFrom: string,
): { workflow: Workflow; warnings: string[] } {
  const branched = compileTraces(traces, compiledFrom);
  const newest = traces[traces.length - 1]!;
  const required = applyRequirements(
    branched.workflow,
    branched.recorded,
    branched.workflow.require ?? [],
    false,
  );
  const workflow = workflowSchema.parse({
    ...markCalculations(
      markDerived(
        markSelective(required.workflow, branched.recorded),
        branched.recorded,
        newest.meta.inputs,
      ),
      branched.recorded,
      newest.meta.inputs,
    ),
    compiledFrom,
  });
  return {
    workflow,
    warnings: [
      ...branched.warnings,
      ...required.warnings,
      ...recordingWarnings(newest, workflow, branched.recorded),
      ...recordingProblems(newest, workflow, branched.recorded),
    ],
  };
}
