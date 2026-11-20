// A workflow compiled from recordings given different inputs (an order id, or
// an email) picks its path from the run's inputs, in code: no model call, and
// a run that gives only an email is not refused for the missing order id.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import { chat, type TraceFile, type TraceToolCall } from "@hotpathrun/shared";
import { compileTraces } from "@hotpathrun/compiler";
import { runWorkflow, type ToolBackend } from "../src/index.js";

const tools = [
  { name: "find_order", inputSchema: {}, annotations: { readOnlyHint: true } },
  {
    name: "find_orders_by_email",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  { name: "archive", inputSchema: {} },
];

function trace(
  inputs: Record<string, unknown>,
  calls: Array<Pick<TraceToolCall, "tool" | "args" | "result">>,
  n: number,
): TraceFile {
  return {
    meta: {
      type: "meta",
      version: 1,
      task: "status",
      startedAt: `2026-10-0${n}T08:00:00Z`,
      server: "node shop.js",
      inputs,
      tools,
    },
    calls: calls.map((c, i) => ({
      type: "tool_call",
      seq: i + 1,
      isError: false,
      startedAt: `2026-10-0${n}T08:00:0${i}Z`,
      durationMs: 5,
      ...c,
    })),
    end: {
      type: "end",
      endedAt: `2026-10-0${n}T08:01:00Z`,
      toolCalls: calls.length,
    },
  };
}
const archive = (id: string) => ({
  tool: "archive",
  args: { ref: `R-${id}` },
  result: { ok: true },
});
const byId = (id: string, n: number) =>
  trace(
    { order_id: id },
    [
      {
        tool: "find_order",
        args: { order_id: id },
        result: { id, ref: `R-${id}` },
      },
      archive(id),
    ],
    n,
  );
const byEmail = (email: string, id: string, n: number) =>
  trace(
    { email },
    [
      {
        tool: "find_orders_by_email",
        args: { email },
        result: { orders: [{ id, ref: `R-${id}` }] },
      },
      archive(id),
    ],
    n,
  );

const workflow = compileTraces(
  [byId("MO-1", 1), byEmail("anna@example.com", "MO-2", 2), byId("MO-3", 3)],
  "test",
).workflow;

function run(inputs: Record<string, string>) {
  const calls: string[] = [];
  const backend: ToolBackend = {
    async call(tool, args) {
      calls.push(tool);
      if (tool === "find_order")
        return {
          value: { id: args.order_id, ref: `R-${args.order_id}` },
          isError: false,
        };
      if (tool === "find_orders_by_email")
        return {
          value: { orders: [{ id: "MO-7", ref: "R-MO-7" }] },
          isError: false,
        };
      return { value: { ok: true }, isError: false };
    },
  };
  const done = runWorkflow(workflow, {
    inputs,
    tools: backend,
    noFallback: true,
  });
  return { done, calls };
}

beforeEach(() => {
  vi.mocked(chat).mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("a workflow with a case per kind of input", () => {
  it("takes the order id path when only an order id is given", async () => {
    const { done, calls } = run({ order_id: "MO-5" });
    await done;
    expect(calls).toEqual(["find_order", "archive"]);
    expect(chat).not.toHaveBeenCalled();
  });

  it("takes the email path when only an email is given", async () => {
    const { done, calls } = run({ email: "bob@example.com" });
    await done;
    expect(calls).toEqual(["find_orders_by_email", "archive"]);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("a run with inputs the workflow was never recorded with", () => {
  const idOnly = compileTraces([byId("MO-1", 1)], "test").workflow;

  it("is drift (the agent does it), not a crash, when it gives other inputs", async () => {
    const backend: ToolBackend = {
      call: async () => ({ value: { ok: true }, isError: false }),
    };
    await expect(
      runWorkflow(idOnly, {
        inputs: { email: "bob@example.com" },
        tools: backend,
        noFallback: true,
      }),
    ).rejects.toMatchObject({ name: "DriftError", stepId: "inputs" });
  });

  it("is still a plain error when the run just forgot an input", async () => {
    const backend: ToolBackend = {
      call: async () => ({ value: { ok: true }, isError: false }),
    };
    await expect(
      runWorkflow(idOnly, { inputs: {}, tools: backend, noFallback: true }),
    ).rejects.toThrow(/missing required input/);
  });
});
