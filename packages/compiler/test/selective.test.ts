// A recorded text that covers only some items of a list is a selection: the
// replay prompt must not say "cover every item". And a recorded text that
// admits a gap is flagged, because every replay repeats it.
import { describe, expect, it } from "vitest";

import type { Workflow } from "@hotpathrun/shared";

import { markSelective } from "../src/coverage.js";
import { hedgeWarnings } from "../src/compile-task.js";

const lines = [
  { ref: "BK-1", description: "Rent" },
  { ref: "BK-2", description: "Fee" },
  { ref: "BK-3", description: "Salary" },
];
const recorded = [{ id: "s1", field: "result" as const, result: lines }];

const workflow = (example: string, required = false): Workflow => ({
  version: 1,
  task: "t",
  compiledFrom: "x",
  server: "in-process",
  inputs: {},
  ...(required ? { require: ["steps.s1.result.*.ref"] } : {}),
  steps: [
    {
      id: "s2",
      type: "llm",
      model: "cheap",
      prompt:
        "s1 lines result:\n{{steps.s1.result}}\n\nwrite the `text`. Use only the data above and cover every item in it.",
      example,
      guard: required
        ? {
            nonEmpty: true,
            grounding: lines.map((l, i) => ({
              value: l.ref,
              paths: [`steps.s1.result.${i}.ref`],
            })),
          }
        : { nonEmpty: true },
    },
  ],
});

describe("markSelective", () => {
  it("marks a step whose text mentions only some items", () => {
    const w = markSelective(
      workflow("Unmatched: BK-2 Fee, total 18"),
      recorded,
    );
    expect(w.steps[0]).toMatchObject({ selective: true });
  });

  it("leaves a step that mentions every item", () => {
    const w = markSelective(
      workflow("BK-1 Rent, BK-2 Fee, BK-3 Salary"),
      recorded,
    );
    expect((w.steps[0] as { selective?: boolean }).selective).toBeUndefined();
  });
});

describe("hedgeWarnings", () => {
  it("flags a recorded sentence that admits a gap", () => {
    const w = hedgeWarnings(
      workflow(
        "Total 12. No GBP rate was retrieved, so I could not convert BK-6.",
      ),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/s2: the recorded text says the agent could not/);
  });

  it("says nothing about a plain text", () => {
    expect(hedgeWarnings(workflow("Total 12 EUR. All lines matched."))).toEqual(
      [],
    );
  });
});
