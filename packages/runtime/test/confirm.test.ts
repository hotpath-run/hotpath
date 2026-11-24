import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  UnconfirmedWorkflowError,
  confirmWorkflow,
  saveWorkflow,
  workflowsDir,
} from "@hotpathrun/compiler";

import { runTask } from "../src/index.js";

const task = `a2-confirm-${Date.now()}`;

afterAll(() => rm(path.join(workflowsDir, `${task}.json`), { force: true }));

describe("runTask and the recording check", () => {
  it("refuses an unconfirmed workflow, before any step runs", async () => {
    await saveWorkflow({
      version: 1,
      task,
      compiledFrom: "x",
      // a server that does not exist: reaching it would be a different error
      server: "does-not-exist",
      inputs: {},
      steps: [],
      confirmed: false,
    });
    await expect(runTask(task, { inputs: {} })).rejects.toThrow(
      UnconfirmedWorkflowError,
    );
    await expect(runTask(task, { inputs: {} })).rejects.toThrow(
      `hotpath confirm ${task}`,
    );
  });

  it("confirmWorkflow lifts the refusal", async () => {
    const wf = await confirmWorkflow(task);
    expect(wf.confirmed).toBe(true);
    // it now gets past the check; the fake server then fails to start
    const err = await runTask(task, { inputs: {} }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnconfirmedWorkflowError);
  });
});
