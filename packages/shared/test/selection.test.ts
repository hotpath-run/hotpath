import { describe, expect, it } from "vitest";

import { learnRules, selectedItems, type Selection } from "../src/selection.js";
import type { TemplateContext } from "../src/template.js";

const day = (
  lines: Array<[string, number, string]>,
  ledger: string[],
): TemplateContext => ({
  inputs: {},
  steps: {
    s1: {
      result: {
        lines: lines.map(([ref, amount, currency]) => ({
          ref,
          amount,
          currency,
        })),
      },
    },
    s2: { result: ledger.map((ref) => ({ ref, amount_eur: 1 })) },
  },
});

// the recorded day: BK-1004 and BK-1007 are not in the ledger
const recorded = day(
  [
    ["BK-1001", 1200, "EUR"],
    ["BK-1002", 840.5, "USD"],
    ["BK-1003", -2400, "EUR"],
    ["BK-1004", -310, "USD"],
    ["BK-1005", -5200, "EUR"],
    ["BK-1006", 450, "GBP"],
    ["BK-1007", -18.5, "EUR"],
  ],
  ["BK-1001", "BK-1002", "BK-1003", "BK-1005", "BK-1006"],
);
// a new day: three lines are unmatched
const today = day(
  [
    ["BK-2001", 2000, "EUR"],
    ["BK-2002", -120, "USD"],
    ["BK-2003", -85.5, "EUR"],
    ["BK-2006", -250, "USD"],
    ["BK-2007", -95, "EUR"],
  ],
  ["BK-2001", "BK-2003"],
);

describe("learnRules", () => {
  it("learns 'not in the ledger' from a reconciliation", () => {
    const rules = learnRules("steps.s1.result.lines", [3, 6], recorded);
    expect(rules).toContainEqual({
      kind: "notIn",
      field: "ref",
      other: "steps.s2.result",
      otherField: "ref",
    });
    // the sign of the amount does not explain it (BK-1003 is negative and matched)
    expect(rules.find((r) => r.kind === "negative")).toBeUndefined();
  });

  it("learns nothing from all items or none", () => {
    expect(learnRules("steps.s1.result.lines", [], recorded)).toEqual([]);
    expect(
      learnRules("steps.s1.result.lines", [0, 1, 2, 3, 4, 5, 6], recorded),
    ).toEqual([]);
  });

  it("learns a category and a sign", () => {
    const usd = learnRules("steps.s1.result.lines", [1, 3], recorded);
    expect(usd).toContainEqual({
      kind: "equals",
      field: "currency",
      value: "USD",
    });
    const out = learnRules("steps.s1.result.lines", [2, 3, 4, 6], recorded);
    expect(out).toContainEqual({ kind: "negative", field: "amount" });
  });

  it("learns nothing when no simple rule reproduces the selection", () => {
    expect(learnRules("steps.s1.result.lines", [0, 3], recorded)).toEqual([]);
  });
});

describe("selectedItems", () => {
  const selection: Selection = {
    list: "steps.s1.result.lines",
    key: "ref",
    rules: [
      {
        kind: "notIn",
        field: "ref",
        other: "steps.s2.result",
        otherField: "ref",
      },
    ],
  };

  it("applies the learned rule to a new day", () => {
    expect(selectedItems(selection, today)?.map((i) => i.ref)).toEqual([
      "BK-2002",
      "BK-2006",
      "BK-2007",
    ]);
  });

  it("keeps only what every rule selects", () => {
    const both: Selection = {
      ...selection,
      rules: [
        ...selection.rules,
        { kind: "equals", field: "currency", value: "USD" },
      ],
    };
    expect(selectedItems(both, today)?.map((i) => i.ref)).toEqual([
      "BK-2002",
      "BK-2006",
    ]);
  });

  it("gives up (null) when the other list is gone", () => {
    const gone: TemplateContext = { ...today, steps: { s1: today.steps.s1! } };
    expect(selectedItems(selection, gone)).toBeNull();
  });
});
