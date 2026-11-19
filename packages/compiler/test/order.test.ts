import { describe, expect, it } from "vitest";

import type { Workflow } from "@hotpathrun/shared";

import { writeBeforeActing } from "../src/order.js";

const llm = (id: string, prompt: string) => ({
  id,
  type: "llm" as const,
  model: "cheap" as const,
  prompt,
  example: "x",
  guard: { nonEmpty: true },
});
const send = (id: string, text: string) => ({
  id,
  type: "tool" as const,
  tool: "send_message",
  args: { to: "x", text },
  sideEffect: true,
  guard: {},
});
const read = {
  id: "s1",
  type: "tool" as const,
  tool: "get_incident",
  args: {},
  sideEffect: false,
  guard: {},
};

const wf = (steps: Workflow["steps"]): Workflow => ({
  version: 1,
  task: "two-places",
  compiledFrom: "t",
  server: "x",
  inputs: {},
  steps,
});

describe("writeBeforeActing (two-places)", () => {
  it("writes both texts before the first message is sent", () => {
    const out = writeBeforeActing(
      wf([
        read,
        llm("s2", "{{steps.s1.result}}"),
        send("s3", "{{steps.s2.output}}"),
        llm("s4", "{{steps.s1.result}}"),
        send("s5", "{{steps.s4.output}}"),
      ]),
    );
    expect(out.steps.map((s) => s.id)).toEqual(["s1", "s2", "s4", "s3", "s5"]);
  });

  it("keeps a text that reads what an action returned after that action", () => {
    const steps = [
      read,
      send("s2", "hello"),
      llm("s3", "the message id was {{steps.s2.result.id}}"),
    ];
    expect(writeBeforeActing(wf(steps)).steps.map((s) => s.id)).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
  });

  it("does not take s1 for s10", () => {
    const steps = [{ ...send("s1", "hi") }, llm("s2", "{{steps.s10.result}}")];
    expect(writeBeforeActing(wf(steps)).steps.map((s) => s.id)).toEqual([
      "s2",
      "s1",
    ]);
  });
});
