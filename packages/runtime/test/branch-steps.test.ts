// Branch steps (different recordings took different paths) and per-item
// conditions in loops. Runs against an in-process tool backend: no server, no model.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Workflow } from "@hotpathrun/shared";

import { DriftError, runWorkflow, type ToolBackend } from "../src/index.js";

let logs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
});
afterEach(() => logSpy.mockRestore());

const inbox = [
  { id: "e1", category: "spam" },
  { id: "e2", category: "normal" },
  { id: "e3", category: "spam" },
  { id: "e4", category: "urgent" },
];

function backend(data: Record<string, unknown>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const tools: ToolBackend = {
    async call(tool, args) {
      calls.push({ tool, args });
      return {
        value: tool in data ? data[tool] : { ok: true },
        isError: false,
      };
    },
  };
  return { tools, calls };
}

const guard = { schema: {} };
const base = {
  version: 1 as const,
  task: "triage",
  compiledFrom: "test",
  server: "in-process",
  inputs: {},
};

function run(workflow: Workflow, data: Record<string, unknown>) {
  const b = backend(data);
  const done = runWorkflow(workflow, {
    inputs: {},
    tools: b.tools,
    noFallback: true,
  });
  return { done, calls: b.calls };
}

describe("per-item conditions in a loop", () => {
  const workflow: Workflow = {
    ...base,
    steps: [
      {
        id: "s1",
        type: "tool",
        tool: "get_inbox",
        args: {},
        sideEffect: false,
        guard,
      },
      {
        id: "s2",
        type: "foreach",
        over: "{{steps.s1.result.emails}}",
        as: "email",
        maxItems: 50,
        body: [
          {
            id: "s2.1",
            type: "tool",
            tool: "archive",
            args: { id: "{{email.id}}" },
            sideEffect: true,
            guard,
            when: { kind: "equals", ref: "email.category", value: "spam" },
          },
        ],
      },
    ],
  };

  it("acts only on the items the rule picks", async () => {
    const { done, calls } = run(workflow, { get_inbox: { emails: inbox } });
    await done;
    expect(
      calls.filter((c) => c.tool === "archive").map((c) => c.args.id),
    ).toEqual(["e1", "e3"]);
  });

  it("acts on none when no item matches (a clean inbox is not drift)", async () => {
    const { done, calls } = run(workflow, {
      get_inbox: { emails: [inbox[1], inbox[3]] },
    });
    await done;
    expect(calls.some((c) => c.tool === "archive")).toBe(false);
  });
});

describe("branch step", () => {
  const send = (id: string, to: string) => ({
    id,
    type: "tool" as const,
    tool: "send_message",
    args: { to, text: "{{steps.s1.result.subject}}" },
    sideEffect: true,
    guard,
  });
  const workflow: Workflow = {
    ...base,
    steps: [
      {
        id: "s1",
        type: "tool",
        tool: "get_email",
        args: {},
        sideEffect: false,
        guard,
      },
      {
        id: "s2",
        type: "branch",
        cases: [
          {
            label: "urgent mail",
            when: {
              kind: "equals",
              ref: "steps.s1.result.priority",
              value: "urgent",
            },
            steps: [send("s3", "oncall")],
          },
          {
            when: {
              kind: "equals",
              ref: "steps.s1.result.priority",
              value: "normal",
            },
            steps: [send("s4", "digest")],
          },
        ],
      },
    ],
  };
  const email = (priority: string) => ({
    get_email: { subject: "Server down", priority },
  });

  it("runs the steps of the first case that matches, and only those", async () => {
    const urgent = run(workflow, email("urgent"));
    await urgent.done;
    expect(urgent.calls.map((c) => c.args.to ?? c.tool)).toEqual([
      "get_email",
      "oncall",
    ]);
    const normal = run(workflow, email("normal"));
    await normal.done;
    expect(normal.calls.map((c) => c.args.to ?? c.tool)).toEqual([
      "get_email",
      "digest",
    ]);
    expect(logs.some((l) => l.includes("s2: took the case"))).toBe(true);
  });

  it("runs the else steps when no case matches", async () => {
    const withElse: Workflow = {
      ...workflow,
      steps: workflow.steps.map((s) =>
        s.type === "branch" ? { ...s, else: [send("s5", "archive")] } : s,
      ),
    };
    const { done, calls } = run(withElse, email("spam"));
    await done;
    expect(calls.map((c) => c.args.to ?? c.tool)).toEqual([
      "get_email",
      "archive",
    ]);
  });

  it("is drift when nothing matches and there is no else: a situation never recorded", async () => {
    const { done, calls } = run(workflow, email("spam"));
    const err = await done.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriftError);
    expect((err as DriftError).stepId).toBe("s2");
    expect((err as Error).message).toMatch(/none of the 2 recorded paths/);
    expect(calls.map((c) => c.tool)).toEqual(["get_email"]);
  });

  it("records the steps it ran, with the branch itself", async () => {
    const { done } = run(workflow, email("urgent"));
    const metrics = await done;
    expect(metrics.steps.map((s) => s.id)).toEqual(["s1", "s3", "s2"]);
  });
});
