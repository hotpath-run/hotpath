// A recording where the agent stopped before any tool call worked (its model
// refused the request, say) compiled into a workflow with no steps, whose
// replays did nothing and counted as successful runs (hard-workflow tests).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileTaskInMemory } from "../src/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hotpath-empty-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const meta = {
  type: "meta",
  version: 1,
  task: "crm",
  startedAt: "2026-11-01T07:00:00.000Z",
  server: "demo",
  inputs: {},
  tools: [
    {
      name: "list_leads",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
  ],
};

async function traceFile(calls: unknown[]): Promise<string> {
  const file = path.join(dir, "crm.jsonl");
  const end = {
    type: "end",
    endedAt: "2026-11-01T07:00:05.000Z",
    toolCalls: calls.length,
  };
  await writeFile(
    file,
    [meta, ...calls, end].map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  return file;
}

describe("a recording where nothing worked", () => {
  it("is refused: nothing is compiled from an agent that stopped before acting", async () => {
    await expect(
      compileTaskInMemory("crm", await traceFile([])),
    ).rejects.toThrow(/no tool call that worked.*record it again/i);
  });

  it("is refused when every call failed", async () => {
    const failed = {
      type: "tool_call",
      seq: 1,
      tool: "list_leads",
      args: {},
      result: { error: "unknown page" },
      isError: true,
      startedAt: "2026-11-01T07:00:01.000Z",
      durationMs: 3,
    };
    await expect(
      compileTaskInMemory("crm", await traceFile([failed])),
    ).rejects.toThrow(/no tool call that worked/i);
  });
});
