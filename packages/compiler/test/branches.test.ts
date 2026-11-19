// Branch learning: several recordings of one task, some making steps the
// others skipped, compile into one workflow whose optional steps have a
// condition (a rule when one tells the runs apart, else a yes/no question).
import { describe, expect, it } from "vitest";

import {
  workflowSchema,
  type TraceFile,
  type TraceToolCall,
} from "@hotpathrun/shared";

import { compileTraces, embed, learnRule, sameShapes } from "../src/index.js";

const tools = [
  { name: "get_inbox", inputSchema: {}, annotations: { readOnlyHint: true } },
  { name: "archive", inputSchema: {} },
  { name: "send_message", inputSchema: {} },
];

function trace(
  date: string,
  calls: Array<Pick<TraceToolCall, "tool" | "args" | "result">>,
): TraceFile {
  return {
    meta: {
      type: "meta",
      version: 1,
      task: "digest",
      startedAt: `${date}T08:00:00Z`,
      server: "node inbox.js",
      inputs: { date },
      tools,
    },
    calls: calls.map((c, i) => ({
      type: "tool_call",
      seq: i + 1,
      isError: false,
      startedAt: `${date}T08:00:0${i}Z`,
      durationMs: 5,
      ...c,
    })),
    end: { type: "end", endedAt: `${date}T08:01:00Z`, toolCalls: calls.length },
  };
}

const inbox = (
  date: string,
  emails: Array<{ subject: string; urgent?: boolean }>,
) => ({
  tool: "get_inbox",
  args: { date },
  result: { emails },
});
const send = (text: string) => ({
  tool: "send_message",
  args: { to: "me", text },
  result: { ok: true },
});

// a busy day sends a digest; a quiet day (no emails) sends nothing
const busy = trace("2026-10-01", [
  inbox("2026-10-01", [
    { subject: "Q3 budget review moved" },
    { subject: "Offsite agenda draft" },
  ]),
  send(
    "Your digest: Q3 budget review moved, and Offsite agenda draft. Nothing else today.",
  ),
]);
const quiet = trace("2026-10-02", [inbox("2026-10-02", [])]);

describe("compileTraces", () => {
  it("one recording: the same workflow as before, no conditions", () => {
    const { workflow, warnings } = compileTraces([busy], "t.jsonl");
    expect(workflowSchema.parse(workflow).steps.every((s) => !s.when)).toBe(
      true,
    );
    expect(warnings).toEqual([]);
  });

  it("learns 'only when there are emails' from a busy and a quiet day", () => {
    for (const order of [
      [busy, quiet],
      [quiet, busy],
    ]) {
      const { workflow, used } = compileTraces(order, "t.jsonl");
      workflowSchema.parse(workflow);
      expect(used).toHaveLength(2);
      const [read, write, sendStep] = workflow.steps;
      expect(read!.type).toBe("tool");
      expect(read!.when).toBeUndefined();
      // the AI step that writes the message is skipped with the send
      expect(write!.type).toBe("llm");
      expect(write!.when).toEqual({
        kind: "nonEmpty",
        ref: "steps.s1.result.emails",
      });
      expect(sendStep!.when).toEqual({
        kind: "nonEmpty",
        ref: "steps.s1.result.emails",
      });
    }
  });

  it("asks the model when no simple rule separates the runs (one example each)", () => {
    const urgent = trace("2026-10-03", [
      inbox("2026-10-03", [{ subject: "Server down", urgent: true }]),
      send(
        "Urgent: Server down needs you right now. Please call the on-call engineer.",
      ),
    ]);
    const calm = trace("2026-10-04", [
      inbox("2026-10-04", [{ subject: "Lunch menu", urgent: false }]),
    ]);
    const { workflow } = compileTraces([calm, urgent], "t.jsonl");
    const sendStep = workflow.steps.find(
      (s) => s.type === "tool" && s.tool === "send_message",
    )!;
    expect(sendStep.when?.kind).toBe("ask");
    if (sendStep.when?.kind !== "ask") throw new Error("expected a question");
    expect(sendStep.when.question).toBe('send_message (to="me")');
    expect(sendStep.when.prompt).toContain("{{steps.s1.result}}");
    expect(sendStep.when.yes).toContain("Server down");
    expect(sendStep.when.no).toContain("Lunch menu");
  });

  // Recordings that share a first step and then diverge become a branch
  // (branch-merge.test.ts); with nothing read in common there is nothing to
  // choose a path by, so the older behaviour stays.
  it("warns and keeps the newest when the recordings share no first step", () => {
    const archived = trace("2026-10-05", [
      { tool: "archive", args: { id: "x" }, result: { ok: true } },
      inbox("2026-10-05", [{ subject: "Spam" }]),
    ]);
    const { workflow, warnings } = compileTraces([busy, archived], "t.jsonl");
    expect(warnings[0]).toMatch(/different steps.*compiled the newest only/);
    expect(
      workflow.steps.map((s) => (s.type === "tool" ? s.tool : s.type)),
    ).toEqual(["archive", "get_inbox"]);
  });

  it("leaves out an older recording whose tool answered in another shape", () => {
    // before a tool change the field was "title"; merging would bring it back
    const old = trace("2026-09-30", [
      {
        tool: "get_inbox",
        args: { date: "2026-09-30" },
        result: { emails: [{ title: "x" }] },
      },
    ]);
    expect(sameShapes(old, busy)).toBe(false);
    const { used, workflow } = compileTraces([old, busy], "t.jsonl");
    expect(used).toEqual([1]);
    expect(workflow.steps.every((s) => !s.when)).toBe(true);
  });
});

describe("learnRule", () => {
  const f = (
    entries: Array<
      [string, { list: number } | { scalar: string | number | boolean | null }]
    >,
  ) => new Map(entries);

  it("empty vs not empty works from one example each", () => {
    expect(
      learnRule([f([["a", { list: 2 }]])], [f([["a", { list: 0 }]])]),
    ).toEqual({ kind: "nonEmpty", ref: "a" });
    expect(
      learnRule([f([["a", { list: 0 }]])], [f([["a", { list: 3 }]])]),
    ).toEqual({ kind: "empty", ref: "a" });
  });

  it("a value match needs two examples on each side", () => {
    const yes = (v: boolean) => f([["urgent", { scalar: v }]]);
    expect(learnRule([yes(true)], [yes(false)])).toBeNull();
    expect(learnRule([yes(true), yes(true)], [yes(false), yes(false)])).toEqual(
      {
        kind: "equals",
        ref: "urgent",
        value: true,
      },
    );
  });
});

describe("embed", () => {
  it("places a shorter path inside a longer one, or says it can't", () => {
    expect(embed(["a", "c"], ["a", "b", "c"])).toEqual([0, 2]);
    expect(embed(["c", "a"], ["a", "b", "c"])).toBeNull();
  });
});
