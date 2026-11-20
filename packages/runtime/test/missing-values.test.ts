// Found by `pnpm fuzz`: a step whose template points at a value today's data
// does not have (item #2 on a day with one item) used to run with that
// argument silently left out: archive_item({}) instead of a stop.
import { describe, expect, it, vi } from "vitest";

vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import type { Workflow } from "@hotpathrun/shared";
import { DriftError, runWorkflow, type ToolBackend } from "../src/index.js";

process.env.HOTPATH_JOURNAL = "0";

function workflow(
  args: Record<string, unknown>,
  sideEffect: boolean,
): Workflow {
  return {
    version: 1,
    task: "missing-values",
    compiledFrom: "test",
    server: "in-process",
    inputs: { date: { example: "2026-10-01" } },
    steps: [
      {
        id: "s1",
        type: "tool",
        tool: "list_items",
        args: { date: "{{inputs.date}}" },
        sideEffect: false,
        guard: {},
      },
      { id: "s2", type: "tool", tool: "act", args, sideEffect, guard: {} },
    ],
  } as Workflow;
}

function tools(items: Array<{ id: string }>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const backend: ToolBackend = {
    async call(tool, args) {
      calls.push({ tool, args });
      return {
        value: tool === "list_items" ? { items } : { ok: true },
        isError: false,
      };
    },
  };
  return { backend, calls };
}

describe("a step whose value is missing today", () => {
  it("stops before an action instead of running it without the value", async () => {
    const { backend, calls } = tools([{ id: "a" }]);
    const run = runWorkflow(
      workflow({ id: "{{steps.s1.result.items.1.id}}" }, true),
      { inputs: { date: "2026-10-01" }, noFallback: true, tools: backend },
    );
    await expect(run).rejects.toBeInstanceOf(DriftError);
    await expect(run).rejects.toThrow(/steps\.s1\.result\.items\.1\.id/);
    expect(calls.map((c) => c.tool)).toEqual(["list_items"]);
  });

  it("stops before a read too, and inside a longer text", async () => {
    const { backend, calls } = tools([]);
    await expect(
      runWorkflow(
        workflow({ note: "about {{steps.s1.result.items.0.id}}" }, false),
        { inputs: { date: "2026-10-01" }, noFallback: true, tools: backend },
      ),
    ).rejects.toBeInstanceOf(DriftError);
    expect(calls.map((c) => c.tool)).toEqual(["list_items"]);
  });

  it("runs as before when every value is there", async () => {
    const { backend, calls } = tools([{ id: "a" }, { id: "b" }]);
    await runWorkflow(
      workflow({ id: "{{steps.s1.result.items.1.id}}" }, true),
      {
        inputs: { date: "2026-10-01" },
        noFallback: true,
        tools: backend,
      },
    );
    expect(calls[1]).toEqual({ tool: "act", args: { id: "b" } });
  });
});
