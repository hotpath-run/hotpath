import { describe, expect, it } from "vitest";

import {
  workflowSchema,
  type TraceFile,
  type TraceToolCall,
  type Workflow,
} from "@hotpathrun/shared";

import { compileTrace } from "../src/index.js";

// "For each email, archive only the spam": the agent called archive for some
// items of a list and not for others, and one field tells the two apart.
const inbox = [
  { id: "e1", subject: "Win a prize", category: "spam" },
  { id: "e2", subject: "Q3 budget", category: "normal" },
  { id: "e3", subject: "Cheap watches", category: "spam" },
  { id: "e4", subject: "Server down", category: "urgent" },
  { id: "e5", subject: "Lunch?", category: "normal" },
];

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

function trace(calls: TraceToolCall[]): TraceFile {
  return {
    meta: {
      type: "meta",
      version: 1,
      task: "triage",
      startedAt: "2026-10-01T07:00:00.000Z",
      server: "demo",
      inputs: { date: "2026-10-01" },
      tools: [
        {
          name: "get_inbox",
          inputSchema: {},
          annotations: { readOnlyHint: true },
        },
        {
          name: "archive",
          inputSchema: {},
          annotations: { readOnlyHint: false },
        },
      ],
    },
    calls,
    end: {
      type: "end",
      endedAt: "2026-10-01T07:00:05.000Z",
      toolCalls: calls.length,
    },
  };
}

const compile = (calls: TraceToolCall[]): Workflow =>
  workflowSchema.parse(compileTrace(trace(calls), "traces/triage/x.jsonl"));

describe("per-item conditions in a loop", () => {
  it("archiving only some items becomes a foreach with a rule on the item", () => {
    const wf = compile([
      call("get_inbox", { date: "2026-10-01" }, { emails: inbox }),
      call("archive", { id: "e1" }, { ok: true }),
      call("archive", { id: "e3" }, { ok: true }),
    ]);
    const loop = wf.steps[1]!;
    expect(loop.type).toBe("foreach");
    if (loop.type !== "foreach") return;
    expect(loop.over).toBe("{{steps.s1.result.emails}}");
    expect(loop.body[0]!.args).toEqual({ id: "{{email.id}}" });
    expect(loop.body[0]!.when).toEqual({
      kind: "equals",
      ref: "email.category",
      value: "spam",
    });
  });

  it("does not guess a rule when no field separates the items it acted on: the replay model decides per item", () => {
    const wf = compile([
      call("get_inbox", { date: "2026-10-01" }, { emails: inbox }),
      // e1 and e2: spam and normal; no rule covers just those two
      call("archive", { id: "e1" }, { ok: true }),
      call("archive", { id: "e2" }, { ok: true }),
    ]);
    // Plain steps used to stay here: archive(emails.0.id), archive(emails.1.id),
    // which a new day replays against whatever sits first and second (the
    // hard-workflow tests). No rule in code still; the decision is the model's.
    expect(wf.steps.map((s) => s.type)).toEqual(["tool", "foreach"]);
    const loop = wf.steps[1]!;
    expect(loop.type === "foreach" && loop.decide?.actions).toEqual([
      { tool: "archive", fields: {} },
    ]);
    expect(loop.type === "foreach" && loop.body[0]!.when).toEqual({
      kind: "equals",
      ref: "choice.action",
      value: "archive",
    });
  });

  it("still compiles the full-cover loop as before (no condition)", () => {
    const wf = compile([
      call("get_inbox", { date: "2026-10-01" }, { emails: inbox }),
      ...inbox.map((e) => call("archive", { id: e.id }, { ok: true })),
    ]);
    const loop = wf.steps[1]!;
    expect(loop.type === "foreach" && loop.body[0]!.when).toBeFalsy();
  });
});
