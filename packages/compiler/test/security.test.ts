// Task names become file names: a name that is a path is refused before any
// file is read or written (docs/SECURITY-REVIEW.md, finding 1).
import { describe, expect, it } from "vitest";

import { TaskNameError, type Workflow } from "@hotpathrun/shared";

import {
  compileTaskInMemory,
  latestTraceFile,
  loadWorkflow,
  saveWorkflow,
} from "../src/index.js";

describe("task names never leave the project folder", () => {
  it("compile, load and the trace lookup refuse a path as a task name", async () => {
    for (const name of ["../x", "..\\x", "a/b", ".."]) {
      await expect(latestTraceFile(name)).rejects.toThrow(TaskNameError);
      await expect(loadWorkflow(name)).rejects.toThrow(TaskNameError);
      await expect(compileTaskInMemory(name)).rejects.toThrow(TaskNameError);
    }
  });

  it("a workflow whose task is a path is not written", async () => {
    const workflow = {
      version: 1,
      task: "../../escaped",
      compiledFrom: "x",
      server: "x",
      inputs: {},
      steps: [],
    } as Workflow;
    await expect(saveWorkflow(workflow)).rejects.toThrow(TaskNameError);
  });
});
