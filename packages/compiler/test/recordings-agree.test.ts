import { describe, expect, it } from "vitest";

import {
  workflowSchema,
  type TraceFile,
  type TraceToolCall,
  type Workflow,
  type WorkflowStep,
} from "@hotpathrun/shared";

import { compileTraces } from "../src/index.js";

// Found by `pnpm fuzz`: recordings of one task that differ only in the data
// (a short day and a long day, a quiet day and a busy one) must compile to a
// workflow that does on each recording's own data what that recording did.

let seq = 0;
function call(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): TraceToolCall {
  seq++;
  return {
    type: "tool_call",
    seq,
    tool,
    args,
    result,
    isError: false,
    startedAt: "2026-10-01T07:00:00.000Z",
    durationMs: 5,
  };
}

const readOnly = new Set(["list_items", "get_item", "get_weather"]);
const tools = [
  "list_items",
  "get_item",
  "get_weather",
  "send_message",
  "archive_item",
].map((name) => ({
  name,
  inputSchema: {},
  annotations: { readOnlyHint: readOnly.has(name) },
}));

function trace(calls: TraceToolCall[]): TraceFile {
  return {
    meta: {
      type: "meta",
      version: 1,
      task: "agree",
      startedAt: "2026-10-01T07:00:00.000Z",
      server: "demo",
      inputs: { date: "2026-10-01" },
      tools,
    },
    calls,
    end: {
      type: "end",
      endedAt: "2026-10-01T07:00:05.000Z",
      toolCalls: calls.length,
    },
  };
}

interface Item {
  id: string;
  title: string;
  amount: number;
  flag: boolean;
}
const item = (n: number, flag = false): Item => ({
  id: `it-${n}x${n * 7}`,
  title: `report number ${n} for review`,
  amount: 100 + n * 37,
  flag,
});
const listCall = (items: Item[]) =>
  call("list_items", { date: "2026-10-01" }, { items });

function compile(traces: TraceFile[]): Workflow {
  return workflowSchema.parse(compileTraces(traces, "traces/agree").workflow);
}
const stepsOf = (w: Workflow, type: WorkflowStep["type"]) =>
  w.steps.filter((s) => s.type === type);

describe("a message that differs between recordings", () => {
  const message = (items: Item[]) =>
    `${items.length} items, total ${items.reduce((a, i) => a + i.amount, 0)} EUR.`;
  const day = (items: Item[]) =>
    trace([
      listCall(items),
      call(
        "send_message",
        { to: "finance", text: message(items) },
        { ok: true },
      ),
    ]);

  it("is written at run time, not frozen to one recording's text", () => {
    const workflow = compile([
      day([item(1), item(2)]),
      day([item(3), item(4), item(5)]),
    ]);
    const send = workflow.steps.find(
      (s) => s.type === "tool" && s.tool === "send_message",
    );
    if (send?.type !== "tool") throw new Error("no send step");
    expect(send.args.text).toMatch(/^\{\{steps\.s\d+\.output\}\}$/);
    expect(stepsOf(workflow, "llm")).toHaveLength(1);
  });

  it("stays written text when only the other recording's text was long", () => {
    const long = trace([
      listCall([item(1), item(2), item(3), item(4)]),
      call(
        "send_message",
        {
          to: "finance",
          text:
            message([item(1), item(2), item(3), item(4)]) +
            " Please check them all today.",
        },
        { ok: true },
      ),
    ]);
    const workflow = compile([long, day([item(5)])]);
    expect(stepsOf(workflow, "llm")).toHaveLength(1);
  });

  it("a constant that is the same in every recording stays a constant", () => {
    const workflow = compile([
      day([item(1), item(2)]),
      day([item(3), item(4)]),
    ]);
    const send = workflow.steps.find(
      (s) => s.type === "tool" && s.tool === "send_message",
    );
    if (send?.type !== "tool") throw new Error("no send step");
    expect(send.args.to).toBe("finance");
  });
});

describe("a read once per item, in recordings with lists of different lengths", () => {
  const digest = (items: Item[]) =>
    trace([
      listCall(items),
      ...items.map((i) =>
        call("get_item", { id: i.id }, { id: i.id, body: `body of ${i.id}` }),
      ),
    ]);

  it("is one loop, whatever the length of the recorded list", () => {
    const workflow = compile([
      digest([item(1)]),
      digest([item(2), item(3), item(4), item(5), item(6)]),
    ]);
    const loops = stepsOf(workflow, "foreach");
    expect(loops).toHaveLength(1);
    expect(
      workflow.steps.some((s) => s.type === "tool" && s.tool === "get_item"),
    ).toBe(false);
  });

  it("is still one loop when the newest recording is the short one", () => {
    const workflow = compile([
      digest([item(2), item(3), item(4)]),
      digest([item(1)]),
    ]);
    expect(stepsOf(workflow, "foreach")).toHaveLength(1);
  });
});

describe("an action some recordings made and others did not", () => {
  const archive = (items: Item[]) =>
    trace([
      listCall(items),
      ...items
        .filter((i) => i.flag)
        .map((i) => call("archive_item", { id: i.id }, { ok: true })),
    ]);

  it("archives only the items the recordings archived", () => {
    const workflow = compile([
      archive([item(1), item(2, true), item(3)]),
      archive([item(4), item(5)]),
      archive([item(6, true), item(7, true), item(8)]),
    ]);
    const loop = workflow.steps.find((s) => s.type === "foreach");
    if (loop?.type !== "foreach") throw new Error("no loop");
    expect(loop.body[0]!.when).toEqual({
      kind: "equals",
      ref: "item.flag",
      value: true,
    });
  });

  it("a single archived item among others is a conditional loop too", () => {
    const workflow = compile([
      archive([item(1), item(2, true)]),
      archive([item(3, true), item(4), item(5, true)]),
      archive([item(6), item(7)]),
    ]);
    const loop = workflow.steps.find((s) => s.type === "foreach");
    if (loop?.type !== "foreach") throw new Error("no loop");
    expect(loop.body[0]!.when).toMatchObject({ ref: "item.flag" });
  });
});

describe("an action made only on days with something to report", () => {
  const maybe = (items: Item[]) =>
    trace([
      listCall(items),
      ...(items.length > 0
        ? [
            call(
              "send_message",
              {
                to: "me",
                text: `New today: ${items.map((i) => i.title).join("; ")}`,
              },
              { ok: true },
            ),
          ]
        : []),
    ]);

  it("is sent only when the list is not empty", () => {
    const workflow = compile([
      maybe([]),
      maybe([item(1)]),
      maybe([item(2), item(3)]),
    ]);
    const conditioned = workflow.steps.filter(
      (s) => s.type === "tool" && s.tool === "send_message",
    );
    expect(conditioned).toHaveLength(1);
    expect((conditioned[0] as { when?: unknown }).when).toEqual({
      kind: "nonEmpty",
      ref: "steps.s1.result.items",
    });
  });

  it("still is when the agent also read something the others never did", () => {
    const noisy = trace([
      call("get_weather", { city: "Oslo" }, { city: "Oslo", summary: "rain" }),
      listCall([]),
    ]);
    const workflow = compile([
      noisy,
      maybe([item(1)]),
      maybe([item(2), item(3)]),
    ]);
    const send = workflow.steps.find(
      (s) => s.type === "tool" && s.tool === "send_message",
    );
    expect((send as { when?: unknown }).when).toMatchObject({
      kind: "nonEmpty",
    });
  });
});
