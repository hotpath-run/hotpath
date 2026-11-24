import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readTrace, workflowSchema } from "@hotpathrun/shared";

import {
  UnconfirmedWorkflowError,
  assertConfirmed,
  compileTrace,
  formatRecordingSummary,
  isConfirmed,
} from "../src/index.js";

const trace = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/morning-brief.jsonl",
);

const compile = async () =>
  workflowSchema.parse(
    compileTrace(await readTrace(trace), "fixtures/morning-brief.jsonl"),
  );

describe("recording check", () => {
  it("treats a workflow without the flag (compiled before the check) as confirmed", async () => {
    const wf = await compile();
    expect(wf.confirmed).toBeUndefined();
    expect(isConfirmed(wf)).toBe(true);
    expect(() => assertConfirmed(wf)).not.toThrow();
  });

  it("refuses an unconfirmed workflow with a message that says how to confirm", async () => {
    const wf = { ...(await compile()), confirmed: false };
    expect(isConfirmed(wf)).toBe(false);
    expect(() => assertConfirmed(wf)).toThrow(UnconfirmedWorkflowError);
    expect(() => assertConfirmed(wf)).toThrow(/hotpath confirm morning-brief/);
  });

  it("the summary shows the side-effect call with its arguments", async () => {
    const wf = await compile();
    const summary = formatRecordingSummary(wf);
    expect(summary).toContain("⚡ send_message");
    expect(summary).toMatch(/text: /);
    expect(summary).toContain("reads:");
  });

  it("the summary lists each recorded per-item decision and the actions inside branch paths", async () => {
    const wf = await compile();
    const tool = wf.steps.find((s) => s.type === "tool" && s.sideEffect)!;
    const loop = {
      id: "s9",
      type: "foreach" as const,
      over: "{{steps.s1.result.items}}",
      as: "item",
      maxItems: 50,
      body: [{ ...tool, id: "s9b" }],
      decide: {
        model: "cheap",
        prompt: "p",
        key: ["id"],
        actions: [{ tool: "set_tier", fields: { tier: "string" as const } }],
        examples: [
          {
            item: { id: "acme" },
            choice: { action: "set_tier", tier: "gold" },
          },
          { item: { id: "zeta" }, choice: { action: "none" } },
        ],
      },
    };
    const branched = {
      ...wf,
      steps: [
        {
          id: "b1",
          type: "branch" as const,
          cases: [{ when: { ask: "urgent?" }, steps: [loop] }],
        },
      ],
    };
    const summary = formatRecordingSummary(branched as never);
    expect(summary).toContain("decided per item (2 recorded)");
    expect(summary).toContain('acme → set_tier {"tier":"gold"}');
    expect(summary).toContain("zeta → none");
    expect(summary).toContain("⚡ send_message");
  });
});
