import { describe, expect, it } from "vitest";

import type { Workflow } from "@hotpathrun/shared";

import {
  correctnessProblems,
  percentile,
  workflowPreservation,
} from "../src/measure-lib.js";

describe("percentile", () => {
  it("is nearest-rank", () => {
    const xs = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(percentile(xs, 50)).toBe(1000);
    expect(percentile(xs, 95)).toBe(1900);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([], 50)).toBeNaN();
  });
});

describe("correctnessProblems", () => {
  const exact = {
    total: { value: -428, tolerance: 0.01 },
    lines: [
      { ref: "BK-2002", amount: -108 },
      { ref: "BK-2007", amount: -95 },
    ],
    matched: ["BK-2001"],
  };
  const good = [
    "Matched: BK-2001 Halvorsen 2000 EUR.",
    "Not in ledger: BK-2002 -120 USD (-108.00 EUR); BK-2007 Refund -95 EUR.",
    "Total unmatched: -428.00 EUR.",
  ].join("\n");

  it("accepts a correct report", () => {
    expect(correctnessProblems(good, exact)).toEqual([]);
  });

  it("a report that mentions the right words but a wrong total is not correct", () => {
    const wrong = good.replace("-428.00", "-423.00");
    expect(correctnessProblems(wrong, exact)[0]).toMatch(/total is 423/);
  });

  it("a missing total, a missing line and a wrong amount are each named", () => {
    expect(
      correctnessProblems("BK-2002 -108 EUR. BK-2007 -95 EUR.", exact),
    ).toEqual(["no total in the report (expected -428)"]);
    expect(
      correctnessProblems(good.replace("BK-2007", "BK-2999"), exact),
    ).toContain("BK-2007 is not in the report");
    expect(
      correctnessProblems(good.replace("(-108.00 EUR)", "(-120 USD)"), exact),
    ).toContain("BK-2002: amount -108 is not shown");
  });

  it("a total that says it excludes a matched item is not a wrong claim", () => {
    const ok = `${good}
Total unmatched: -428.00 EUR (excludes BK-2001 until reviewed).`;
    expect(correctnessProblems(ok, exact)).toEqual([]);
  });

  it("calls out a matched item reported as missing", () => {
    const bad = good + "\nBK-2001 is not in the ledger.";
    expect(correctnessProblems(bad, exact)).toContain(
      "BK-2001 is matched but the report calls it missing",
    );
  });
});

describe("workflowPreservation", () => {
  const wf = (
    over: Partial<{ to: string; grounding: number; tools: number }> = {},
  ): Workflow => ({
    version: 1,
    task: "t",
    compiledFrom: "x",
    server: "in-process",
    inputs: {},
    steps: [
      {
        id: "s1",
        type: "tool",
        tool: "get",
        args: {},
        sideEffect: false,
        guard: { schema: { type: "object" } },
      },
      {
        id: "s2",
        type: "llm",
        model: "cheap",
        prompt: "p",
        example: "e",
        guard: {
          nonEmpty: true,
          maxChars: 500,
          grounding: Array.from({ length: over.grounding ?? 2 }, () => ({
            value: "x",
            paths: ["steps.s1.result"],
          })),
        },
      },
      {
        id: "s3",
        type: "tool",
        tool: "send",
        args: { to: over.to ?? "controller", text: "{{steps.s2.output}}" },
        sideEffect: true,
        guard: {},
      },
    ],
  });

  it("an identical recompile preserves everything", () => {
    const p = workflowPreservation(wf(), wf());
    expect(p).toMatchObject({ sideEffects: true, guards: true, problems: [] });
  });

  it("a changed recipient or lost grounding is a problem", () => {
    const p = workflowPreservation(wf(), wf({ to: "someone-else" }));
    expect(p.sideEffects).toBe(false);
    const q = workflowPreservation(wf(), wf({ grounding: 0 }));
    expect(q.problems).toContain("the AI step lost all its grounding checks");
  });
});

describe("correctnessProblems: wording that is not a wrong claim", () => {
  const exact = { matched: ["BK-1006"] };
  it("a pending item named beside the total is not called missing", () => {
    expect(
      correctnessProblems(
        "Total unmatched: -297.50 EUR (BK-1004); BK-1006 pending a GBP rate.",
        exact,
      ),
    ).toEqual([]);
  });
  it("a matched item inside an 'Unmatched:' list is a wrong claim", () => {
    expect(
      correctnessProblems("Unmatched: BK-1004, BK-1006", exact),
    ).toHaveLength(1);
  });
});
