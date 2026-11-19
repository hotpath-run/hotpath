import { describe, expect, it } from "vitest";

import type { Workflow } from "@hotpathrun/shared";

import { allSteps, summarize, workflowToGraph } from "../src/graph.js";

const send = (id: string, to: string) => ({
  id,
  type: "tool" as const,
  tool: "send_message",
  args: { to, text: "x" },
  sideEffect: true,
  guard: {},
});

const workflow: Workflow = {
  version: 1,
  task: "triage",
  compiledFrom: "test",
  server: "demo",
  inputs: {},
  steps: [
    {
      id: "s1",
      type: "tool",
      tool: "get_email",
      args: {},
      sideEffect: false,
      guard: {},
    },
    {
      id: "b1",
      type: "branch",
      cases: [
        {
          when: {
            kind: "equals",
            ref: "steps.s1.result.priority",
            value: "urgent",
          },
          steps: [send("s2", "oncall")],
        },
        {
          when: {
            kind: "equals",
            ref: "steps.s1.result.priority",
            value: "spam",
          },
          steps: [send("s2b1", "archive"), send("s3b1", "log")],
        },
      ],
    },
  ],
};

describe("branches in the viewer graph", () => {
  it("draws a branch as a group with a labelled lane per path", () => {
    const { nodes, edges } = workflowToGraph(workflow);
    expect(nodes.map((n) => `${n.id}:${n.type}`)).toEqual([
      "s1:step",
      "b1:branch",
      "b1:case0:step",
      "s2:step",
      "b1:case1:step",
      "s2b1:step",
      "s3b1:step",
    ]);
    const label = nodes.find((n) => n.id === "b1:case0")!;
    expect(label.data.label).toBe('if steps.s1.result.priority is "urgent"');
    expect(label.parentId).toBe("b1");
    const lane1 = nodes.find((n) => n.id === "s2b1")!;
    const lane0 = nodes.find((n) => n.id === "s2")!;
    expect(lane1.position.x).toBeGreaterThan(lane0.position.x);
    expect(lane1.parentId).toBe("b1");
    // the branch reads what s1 returned
    expect(edges).toContainEqual({ id: "s1->b1", source: "s1", target: "b1" });
  });

  it("selects steps inside branches by id and counts them", () => {
    expect(allSteps(workflow).map((s) => s.id)).toEqual([
      "s1",
      "b1",
      "s2",
      "s2b1",
      "s3b1",
    ]);
    expect(summarize(workflow)).toContain("1 branch");
  });
});
