import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readTrace } from "@hotpathrun/shared";

import { compileRecording } from "../src/index.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "bank-reconciliation.jsonl",
);

describe("compileRecording (one recording in memory, for the cloud Studio)", () => {
  it("compiles the same kinds of steps a file-based compile does", async () => {
    const trace = await readTrace(fixture);
    const { workflow } = compileRecording(trace, "studio", 0.012);
    expect(workflow.task).toBe(trace.meta.task);
    expect(workflow.compiledFrom).toBe("studio");
    expect(workflow.steps.map((s) => s.type)).toContain("llm");
    expect(
      workflow.steps.filter((s) => s.type === "tool").length,
    ).toBeGreaterThan(0);
    // inputs the recording was given become workflow inputs
    expect(Object.keys(workflow.inputs)).toEqual(
      Object.keys(trace.meta.inputs),
    );
  });

  it("takes the baseline from the recording and the agent's reported cost", async () => {
    const trace = await readTrace(fixture);
    const { workflow } = compileRecording(trace, "studio", 0.012);
    expect(workflow.baseline).toEqual({
      durationMs:
        Date.parse(trace.end.endedAt) - Date.parse(trace.meta.startedAt),
      costUsd: 0.012,
    });
    expect(
      compileRecording(trace, "studio").workflow.baseline,
    ).not.toHaveProperty("costUsd");
  });

  it("learns the calculation of the finance task, like the file-based compile", async () => {
    const trace = await readTrace(fixture);
    const { workflow } = compileRecording(trace, "studio");
    const llm = workflow.steps.find((s) => s.type === "llm") as {
      calculations?: unknown[];
    };
    expect(llm.calculations?.length ?? 0).toBeGreaterThan(0);
  });

  it("reads and writes no files", async () => {
    const trace = await readTrace(fixture);
    // a task name with no folder anywhere: a file-based compile would look for one
    const { workflow } = compileRecording(
      { ...trace, meta: { ...trace.meta, task: "studio-only-task" } },
      "studio",
    );
    expect(workflow.task).toBe("studio-only-task");
  });
});
