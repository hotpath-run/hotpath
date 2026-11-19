// Figures the agent calculated (a total, a converted amount) are found in the
// recorded text, so the replay prompt can ask for the same kinds of lines.
import { describe, expect, it } from "vitest";

import type { Workflow } from "@hotpathrun/shared";

import {
  derivedLines,
  CALCULATED,
  markDerived,
  strongNotes,
} from "../src/derived.js";

const lines = [
  { ref: "BK-1001", description: "Rent", amount: 1200, currency: "EUR" },
  { ref: "BK-1002", description: "Stripe", amount: 840.5, currency: "USD" },
  { ref: "BK-1004", description: "AWS invoice", amount: -310, currency: "USD" },
  { ref: "BK-1007", description: "Bank fee", amount: -18.5, currency: "EUR" },
];
const rate = { currency: "USD", eur_per_unit: 0.9 };

describe("derivedLines", () => {
  const text = [
    "Bank reconciliation 2026-10-01. Unmatched lines:",
    "- BK-1004, AWS invoice: -310.00 USD x 0.9 = -279.00 EUR",
    "- BK-1007, Bank fee: -18.50 EUR",
    "Total unmatched: -297.50 EUR.",
    "Other refs (BK-1001, 1002) agree.",
  ].join("\n");

  it("finds lines with a figure that is in none of the data, hiding the figure", () => {
    expect(derivedLines(text, [lines, rate], { date: "2026-10-01" })).toEqual([
      `- BK-1004, AWS invoice: -310.00 USD x 0.9 = ${CALCULATED} EUR`,
      `Total unmatched: ${CALCULATED} EUR.`,
    ]);
  });

  it("does not count dates, identifiers or numbers that are in the data", () => {
    expect(
      derivedLines("BK-1007 Bank fee -18.50 EUR on 2026-10-01", [lines], {
        date: "2026-10-01",
      }),
    ).toEqual([]);
  });
});

describe("markDerived gives calculation steps to the stronger model", () => {
  const wf = (): Workflow => ({
    version: 1,
    task: "t",
    compiledFrom: "x",
    server: "in-process",
    inputs: {},
    steps: [
      {
        id: "s2",
        type: "llm",
        model: "cheap",
        prompt: "x",
        example: "Total unmatched: -297.50 EUR.",
        guard: { nonEmpty: true },
      },
    ],
  });
  const recorded = [{ id: "s1", field: "result" as const, result: lines }];

  it("HOTPATH_STRONG_CALC=1 makes a step with a calculated figure model: strong, with a note", () => {
    process.env.HOTPATH_STRONG_CALC = "1";
    try {
      const out = markDerived(wf(), recorded, {});
      expect(out.steps[0]).toMatchObject({ model: "strong" });
      expect(strongNotes(out)).toHaveLength(1);
    } finally {
      delete process.env.HOTPATH_STRONG_CALC;
    }
  });

  it("by default the cheap model keeps the step", () => {
    expect(markDerived(wf(), recorded, {}).steps[0]).toMatchObject({
      model: "cheap",
    });
  });

  it("a step with only copied figures stays cheap", () => {
    const w = wf();
    (w.steps[0] as { example: string }).example = "BK-1004 AWS invoice -310";
    expect(markDerived(w, recorded, {}).steps[0]).toMatchObject({
      model: "cheap",
    });
  });
});
