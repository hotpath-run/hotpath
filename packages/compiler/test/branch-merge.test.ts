import { describe, expect, it } from "vitest";

import {
  workflowSchema,
  type TraceFile,
  type TraceToolCall,
  type Workflow,
} from "@hotpathrun/shared";

import { compileTraces, formatWorkflow } from "../src/index.js";

// Recordings that took DIFFERENT steps: urgent mail pages the on-call, normal
// mail goes to the digest, spam is archived. The discriminator is a field of
// what the agent read first.
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

const tools = ["get_email", "page_oncall", "add_to_digest", "archive"].map(
  (name) => ({
    name,
    inputSchema: {},
    annotations: { readOnlyHint: name === "get_email" },
  }),
);

function trace(calls: TraceToolCall[]): TraceFile {
  return {
    meta: {
      type: "meta",
      version: 1,
      task: "triage",
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

/** One recording of the task: read the email, then the action for its kind. */
function recording(
  field: string,
  value: string,
  action: string,
  subject = `Mail ${seq}`,
): TraceFile {
  return trace([
    call("get_email", { date: "2026-10-01" }, { subject, [field]: value }),
    call(action, { reason: `handled ${value}` }, { ok: true }),
  ]);
}

const urgent = (f = "priority") => recording(f, "urgent", "page_oncall");
const normal = (f = "priority") => recording(f, "normal", "add_to_digest");
const spam = (f = "priority") => recording(f, "spam", "archive");

function merge(traces: TraceFile[]) {
  const result = compileTraces(traces, "traces/triage");
  return {
    ...result,
    workflow: workflowSchema.parse(result.workflow) as Workflow,
  };
}

describe("recordings that took different paths", () => {
  it("become one branch step with a case per path", () => {
    const { workflow, warnings } = merge([urgent(), normal(), spam()]);
    expect(warnings).toEqual([]);
    expect(workflow.steps.map((s) => s.type)).toEqual(["tool", "branch"]);
    const branch = workflow.steps[1]!;
    if (branch.type !== "branch") throw new Error("not a branch");
    expect(branch.cases).toHaveLength(3);
    expect(branch.else).toBeUndefined();
    expect(
      branch.cases.map((c) => c.steps.map((s) => s.type === "tool" && s.tool)),
    ).toEqual([["page_oncall"], ["add_to_digest"], ["archive"]]);
    expect(branch.cases.map((c) => c.when)).toEqual([
      { kind: "equals", ref: "steps.s1.result.priority", value: "urgent" },
      { kind: "equals", ref: "steps.s1.result.priority", value: "normal" },
      { kind: "equals", ref: "steps.s1.result.priority", value: "spam" },
    ]);
  });

  it("keeps step ids unique across cases", () => {
    const { workflow } = merge([urgent(), normal(), spam()]);
    const branch = workflow.steps[1]!;
    if (branch.type !== "branch") throw new Error("not a branch");
    const ids = [
      workflow.steps[0]!.id,
      branch.id,
      ...branch.cases.flatMap((c) => c.steps.map((s) => s.id)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("learns a rule from a field that looks like a category, even from one example per path", () => {
    const { workflow } = merge([urgent("category"), normal("category")]);
    const branch = workflow.steps[1]!;
    if (branch.type !== "branch") throw new Error("not a branch");
    expect(branch.cases[0]!.when).toMatchObject({
      kind: "equals",
      ref: "steps.s1.result.category",
    });
  });

  it("does not trust a one-example rule on a field that is not a category (it asks the model)", () => {
    const { workflow } = merge([urgent("note"), normal("note")]);
    const branch = workflow.steps[1]!;
    if (branch.type !== "branch") throw new Error("not a branch");
    expect(branch.cases.map((c) => c.when.kind)).toEqual(["ask", "ask"]);
  });

  it("two recordings of one path stay a plain workflow, without a branch", () => {
    const { workflow } = merge([urgent(), urgent()]);
    expect(workflow.steps.map((s) => s.type)).toEqual(["tool", "tool"]);
  });

  it("an extra-steps difference still uses the older condition on steps, not a branch", () => {
    const quiet = trace([
      call("get_email", { date: "2026-10-01" }, { subject: "x", priority: [] }),
    ]);
    const busy = urgent();
    const { workflow } = merge([quiet, busy]);
    expect(workflow.steps.some((s) => s.type === "branch")).toBe(false);
  });

  it("hotpath show prints every path", () => {
    const { workflow } = merge([urgent(), normal(), spam()]);
    const text = formatWorkflow(workflow);
    expect(text).toContain("b1 branch");
    expect(text).toContain('if steps.s1.result.priority is "urgent":');
    expect(text).toContain("page_oncall");
    expect(text).toContain("archive");
  });
});
