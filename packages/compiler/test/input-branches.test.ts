// Recordings given different inputs (an order id, or an email) take different
// first steps. The path is chosen by a rule on the inputs: nothing has been
// read at the first step, so a question to the replay model has nothing to go on.
import { describe, expect, it } from "vitest";

import {
  workflowSchema,
  type TraceFile,
  type TraceToolCall,
  type Workflow,
} from "@hotpathrun/shared";

import { compileTraces } from "../src/index.js";

const tools = [
  { name: "find_order", inputSchema: {}, annotations: { readOnlyHint: true } },
  {
    name: "find_orders_by_email",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  { name: "archive", inputSchema: {} },
  { name: "notify", inputSchema: {} },
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

const byId = (id: string, n: number) =>
  trace(
    { order_id: id, note: "hi" },
    [
      {
        tool: "find_order",
        args: { order_id: id },
        result: { id, ref: `R-${id}` },
      },
      { tool: "archive", args: { ref: `R-${id}` }, result: { ok: true } },
    ],
    n,
  );
const byEmail = (email: string, id: string, n: number) =>
  trace(
    { email, note: "hi" },
    [
      {
        tool: "find_orders_by_email",
        args: { email },
        result: { orders: [{ id, ref: `R-${id}` }] },
      },
      { tool: "archive", args: { ref: `R-${id}` }, result: { ok: true } },
    ],
    n,
  );

const traces = [
  byId("MO-1", 1),
  byEmail("anna@example.com", "MO-2", 2),
  byId("MO-3", 3),
];

function compiled(): Workflow {
  const result = compileTraces(traces, "test");
  return workflowSchema.parse(result.workflow);
}

describe("recordings that were given different inputs", () => {
  it("choose the path by a rule on the inputs, never by a question", () => {
    const workflow = compiled();
    const json = JSON.stringify(workflow.steps);
    expect(json).not.toContain('"ask"');
    const branch = workflow.steps[0]!;
    expect(branch.type).toBe("branch");
    if (branch.type !== "branch") return;
    expect(branch.cases.map((c) => c.when)).toEqual([
      { kind: "nonEmpty", ref: "inputs.order_id" },
      { kind: "nonEmpty", ref: "inputs.email" },
    ]);
    expect(
      branch.cases.map((c) => c.steps.find((s) => s.type === "tool")),
    ).toMatchObject([{ tool: "find_order" }, { tool: "find_orders_by_email" }]);
  });

  it("declare only the inputs every recording had as required", () => {
    const { inputs } = compiled();
    expect(inputs.note?.required).toBeUndefined();
    expect(inputs.order_id?.required).toBe(false);
    expect(inputs.email?.required).toBe(false);
    expect(inputs.email?.example).toBe("anna@example.com");
  });

  it("leave a step no rule can separate always running, with a warning", () => {
    // two recordings with the same inputs, one notified and one not: no data
    // exists yet at step 1, so asking the model would be a guess
    const a = trace(
      { order_id: "MO-1", note: "hi" },
      [
        { tool: "notify", args: { to: "ops" }, result: { ok: true } },
        { tool: "archive", args: { ref: "R-MO-1" }, result: { ok: true } },
      ],
      1,
    );
    const b = trace(
      { order_id: "MO-9", note: "hi" },
      [{ tool: "archive", args: { ref: "R-MO-9" }, result: { ok: true } }],
      2,
    );
    const result = compileTraces([a, b], "test");
    expect(JSON.stringify(result.workflow.steps)).not.toContain('"ask"');
    expect(result.warnings.join(" ")).toContain("always run");
  });
});

describe("the AI step's prompt", () => {
  it("shows the free-text request and says to answer in its language", () => {
    const t = trace(
      { order_id: "MO-1", message: "Hola, ¿dónde está mi pedido MO-1?" },
      [
        {
          tool: "find_order",
          args: { order_id: "MO-1" },
          result: { id: "MO-1" },
        },
        {
          tool: "send_reply",
          args: {
            text: "Hola, su pedido MO-1 está en camino. Gracias por esperar.",
          },
          result: { ok: true },
        },
      ],
      1,
    );
    const llm = compileTraces([t], "test").workflow.steps.find(
      (s) => s.type === "llm",
    );
    expect(llm?.type === "llm" && llm.prompt).toContain("{{inputs.message}}");
    expect(llm?.type === "llm" && llm.prompt).toMatch(
      /language of the request/,
    );
    // an id is not a request: it stays out
    expect(llm?.type === "llm" && llm.prompt).not.toContain(
      "{{inputs.order_id}}",
    );
  });
});
