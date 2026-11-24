// A recording where the agent read its data and then stopped before its first action
// (an error, a timeout, a model that answered in text) compiled into a workflow that
// only reads: every replay "succeeded" and did nothing (sales on a free model, hard
// bench). Compile refuses it and says what went wrong, unless the task only reads.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HalfDoneRecordingError,
  compileTaskInMemory,
  halfDoneRecording,
  workflowsDir,
} from "../src/index.js";
import { readTrace } from "@hotpathrun/shared";

let dir: string;
const task = `halfdone-${process.pid}`;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hotpath-halfdone-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(path.join(workflowsDir, `${task}.json`), { force: true });
});

const meta = {
  type: "meta",
  version: 1,
  task,
  startedAt: "2026-11-01T07:00:00.000Z",
  server: "demo",
  inputs: { date: "2026-11-01" },
  tools: [
    {
      name: "get_deals",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_regions",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    { name: "send_message", inputSchema: {} },
  ],
};

let seq = 0;
const call = (tool: string, result: unknown, isError = false) => ({
  type: "tool_call",
  seq: ++seq,
  tool,
  args: { date: "2026-11-01" },
  result,
  isError,
  startedAt: "2026-11-01T07:00:01.000Z",
  durationMs: 3,
});

async function traceFile(
  calls: unknown[],
  tools: unknown[] = meta.tools,
): Promise<string> {
  const file = path.join(dir, `${task}.jsonl`);
  const end = {
    type: "end",
    endedAt: "2026-11-01T07:00:05.000Z",
    toolCalls: calls.length,
  };
  await writeFile(
    file,
    [{ ...meta, tools }, ...calls, end]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  return file;
}

const deals = { deals: [{ id: "d1", amount: 1200 }] };

describe("halfDoneRecording", () => {
  it("names the reads it made when it stopped before any action", async () => {
    const trace = await readTrace(
      await traceFile([call("get_deals", deals), call("get_deals", deals)]),
    );
    const problem = halfDoneRecording(trace);
    expect(problem).toMatch(/get_deals ×2/);
    expect(problem).toMatch(/never called an action tool \(send_message\)/);
  });

  it("quotes the last call's error when the run ended on one", async () => {
    const trace = await readTrace(
      await traceFile([
        call("get_deals", deals),
        call("get_regions", { error: "rate limited, retry in 60s" }, true),
      ]),
    );
    expect(halfDoneRecording(trace)).toMatch(
      /last call \(get_regions\) failed: .*rate limited/,
    );
  });

  it("is quiet when the agent acted, or when the server has no action tool", async () => {
    const acted = await readTrace(
      await traceFile([
        call("get_deals", deals),
        call("send_message", { ok: true }),
      ]),
    );
    expect(halfDoneRecording(acted)).toBeNull();
    const readsOnly = await readTrace(
      await traceFile(
        [call("get_deals", deals)],
        meta.tools.filter((t) => t.name !== "send_message"),
      ),
    );
    expect(halfDoneRecording(readsOnly)).toBeNull();
  });

  it("counts a failed action as no action", async () => {
    const trace = await readTrace(
      await traceFile([
        call("get_deals", deals),
        call("send_message", { error: "channel not found" }, true),
      ]),
    );
    expect(halfDoneRecording(trace)).toMatch(/last call \(send_message\)/);
  });
});

describe("compile", () => {
  it("refuses a half-done recording with what went wrong and what to do", async () => {
    const file = await traceFile([call("get_deals", deals)]);
    const err = await compileTaskInMemory(task, file).catch((e) => e);
    expect(err).toBeInstanceOf(HalfDoneRecordingError);
    expect(err.message).toMatch(/get_deals/);
    expect(err.message).toMatch(/record it again/);
    expect(err.message).toMatch(/--read-only/);
  });

  it("compiles it with --read-only and marks the workflow, so later compiles keep it", async () => {
    const file = await traceFile([call("get_deals", deals)]);
    const { workflow } = await compileTaskInMemory(task, file, {
      readOnly: true,
    });
    expect(workflow.readOnly).toBe(true);
    // a saved read-only workflow carries the choice to the next compile
    await writeFile(
      path.join(workflowsDir, `${task}.json`),
      JSON.stringify(workflow),
    );
    const again = await compileTaskInMemory(task, file);
    expect(again.workflow.readOnly).toBe(true);
  });

  it("does not mark a workflow that acted", async () => {
    const file = await traceFile([
      call("get_deals", deals),
      call("send_message", { ok: true }),
    ]);
    const { workflow } = await compileTaskInMemory(task, file);
    expect(workflow.readOnly).toBeUndefined();
  });
});
