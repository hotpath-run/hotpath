// A rulebook for per-item choices, learned from the recorded items: the hard
// bench's support triage, where a free replay model forwarded a 50 refund the same
// way twice (decide twice cannot catch an answer that is wrong both times).
import { describe, expect, it } from "vitest";

import { tableDecision, type ItemDecision } from "@hotpathrun/shared";

import { learnTable } from "../src/decision-table.js";

const ticket = (
  id: string,
  category: string,
  priority: string,
  amount: number | null,
  choice: Record<string, unknown>,
) => ({
  item: { id, subject: `${category} #${id}`, customer_id: "C1" },
  details: {
    id,
    subject: `${category} #${id}`,
    body: `text ${id}`,
    category,
    priority,
    amount,
  },
  choice,
});
const decide = (examples: ItemDecision["examples"]): ItemDecision => ({
  model: "cheap",
  prompt: "",
  key: ["id"],
  details: { step: "s2" },
  actions: [
    { tool: "tag_ticket", fields: { tag: "string" } },
    { tool: "issue_refund", fields: { amount: "number" } },
    { tool: "escalate", fields: {} },
    { tool: "forward_to_finance", fields: {} },
    { tool: "close_ticket", fields: {} },
  ],
  examples,
});
// the recording of the hard bench (2026-11-23)
const RECORDED = decide([
  ticket("T200", "bug", "low", null, { action: "tag_ticket", tag: "bug" }),
  ticket("T201", "billing", "low", 35, { action: "issue_refund", amount: 35 }),
  ticket("T202", "bug", "high", null, { action: "escalate" }),
  ticket("T203", "bug", "low", null, { action: "tag_ticket", tag: "bug" }),
  ticket("T204", "billing", "low", 200, { action: "forward_to_finance" }),
  ticket("T205", "feature", "low", null, {
    action: "tag_ticket",
    tag: "feature",
  }),
  ticket("T206", "billing", "low", 50, { action: "issue_refund", amount: 50 }),
  ticket("T207", "billing", "high", 75, { action: "forward_to_finance" }),
  ticket("T208", "bug", "low", null, { action: "tag_ticket", tag: "bug" }),
  ticket("T209", "feature", "low", null, {
    action: "tag_ticket",
    tag: "feature",
  }),
  ticket("T210", "billing", "low", 120, { action: "forward_to_finance" }),
  ticket("T211", "spam", "low", null, { action: "close_ticket" }),
  ticket("T212", "billing", "high", 50, { action: "issue_refund", amount: 50 }),
  ticket("T213", "bug", "low", null, { action: "tag_ticket", tag: "bug" }),
]);

const decideOne = (
  table: NonNullable<ReturnType<typeof learnTable>>,
  category: string,
  priority: string,
  amount: number | null,
) => tableDecision(table, {}, { category, priority, amount, body: "new text" });

describe("a rulebook for per-item choices", () => {
  const table = learnTable(RECORDED, [])!;

  it("learns category first, then priority for bugs and the amount for billing", () => {
    expect(table).toMatchObject({ from: "details", path: ["category"] });
    expect(decideOne(table, "bug", "high", null)).toEqual({
      decision: { action: "escalate" },
    });
    expect(decideOne(table, "bug", "low", null)).toEqual({
      decision: { action: "tag_ticket", tag: "bug" },
    });
    expect(decideOne(table, "spam", "high", null)).toEqual({
      decision: { action: "close_ticket" },
    });
    expect(decideOne(table, "feature", "low", null)).toEqual({
      decision: { action: "tag_ticket", tag: "feature" },
    });
  });

  it("refunds the ticket's own amount up to the recorded refunds, forwards from the recorded forwards", () => {
    expect(decideOne(table, "billing", "low", 20)).toEqual({
      decision: { action: "issue_refund", amount: 20 },
    });
    expect(decideOne(table, "billing", "high", 50)).toEqual({
      decision: { action: "issue_refund", amount: 50 },
    });
    expect(decideOne(table, "billing", "low", 200)).toEqual({
      decision: { action: "forward_to_finance" },
    });
  });

  it("an amount between the recorded ones is a gap, a new category is unknown", () => {
    expect(decideOne(table, "billing", "low", 60)).toEqual({
      gap: "amount 60",
    });
    expect(decideOne(table, "legal", "low", null)).toEqual({
      unknown: 'category "legal"',
    });
  });

  it("closes the amount gap at a threshold the agent wrote", () => {
    // a written 60 between the recorded 50 (refund) and 75 (forward) closes the gap
    const t60 = learnTable(RECORDED, [60])!;
    expect(decideOne(t60, "billing", "low", 59)).toMatchObject({
      decision: { action: "issue_refund" },
    });
    expect(decideOne(t60, "billing", "low", 60)).toEqual({
      decision: { action: "forward_to_finance" },
    });
  });

  it("never splits on free text, and learns nothing when the choices do not follow the fields", () => {
    const byBody = decide(
      RECORDED.examples.map((e, i) => ({
        ...e,
        // the action no longer follows category, priority or amount
        choice: i % 2 ? { action: "close_ticket" } : { action: "escalate" },
      })),
    );
    expect(learnTable(byBody, [])).toBeNull();
  });
});
