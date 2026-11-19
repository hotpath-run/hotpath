import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  computeFigures,
  statesFigure,
  type TemplateContext,
} from "@hotpathrun/shared";

import { learnCalculations } from "../src/calculations.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../examples/demo-tools/fixtures",
);

// the finance demo's data as the workflow's steps see it: bank lines (pages
// merged), ledger, and two exchange rates
async function day(set: string, rates: string[]): Promise<TemplateContext> {
  const f = JSON.parse(
    await readFile(path.join(fixtures, set, "finance.json"), "utf8"),
  );
  const steps: TemplateContext["steps"] = {
    s1: { result: { lines: f.pages.flat() } },
    s2: { result: f.ledger },
  };
  rates.forEach((c, i) => {
    steps[`s${i + 3}`] = { result: { currency: c, eur_per_unit: f.rates[c] } };
  });
  return { inputs: { date: f.date }, steps };
}

const EXAMPLE =
  "Reconciliation Report for 2026-10-01:\n\nUnmatched Bank Lines:\n" +
  "- BK-1004: AWS invoice (-310 USD = -279 EUR)\n- BK-1007: Bank fee (-18.5 EUR)\n\n" +
  "Total unmatched amount: -297.5 EUR.";

describe("learnCalculations", () => {
  it("explains the recorded total and the converted amount", async () => {
    const recorded = await day("default", ["USD", "GBP"]);
    const calcs = learnCalculations(EXAMPLE, recorded);
    const total = calcs.find((c) => c.recorded === -297.5);
    expect(total).toMatchObject({
      op: "sum",
      field: "amount",
      line: "Total unmatched amount: <calculated> EUR.",
      selection: {
        rules: [{ kind: "notIn", field: "ref", otherField: "ref" }],
      },
      convert: { currencyField: "currency", base: "EUR" },
    });
    const each = calcs.find((c) => c.recorded === -279);
    expect(each).toMatchObject({ op: "each", key: "ref", field: "amount" });
  });

  it("computes today's figures on new data, with the rule learned from the recording", async () => {
    const calcs = learnCalculations(
      EXAMPLE,
      await day("default", ["USD", "GBP"]),
    );
    const today = await day("new-data", ["USD", "USD"]);
    const total = computeFigures(
      calcs.find((c) => c.op === "sum")!,
      today,
    );
    expect(total).toEqual([
      { text: "Total unmatched amount: -428 EUR.", value: -428 },
    ]);
    const each = computeFigures(
      calcs.find((c) => c.op === "each")!,
      today,
    );
    expect(each?.map((f) => f.text)).toEqual([
      "BK-2002: -108 EUR",
      "BK-2006: -225 EUR",
      "BK-2007: -95 EUR",
    ]);
  });

  it("claims nothing when a needed rate was not read today", async () => {
    const calcs = learnCalculations(
      EXAMPLE,
      await day("default", ["USD", "GBP"]),
    );
    const noUsd = await day("new-data", ["GBP", "GBP"]);
    expect(
      computeFigures(
        calcs.find((c) => c.op === "sum")!,
        noUsd,
      ),
    ).toBeNull();
  });

  it("learns nothing from a text whose figures are all in the data", async () => {
    expect(
      learnCalculations(
        "BK-1004 AWS invoice -310 USD",
        await day("default", ["USD"]),
      ),
    ).toEqual([]);
  });
});

describe("statesFigure", () => {
  it("accepts the figure however its sign and decimals are written", () => {
    expect(statesFigure("Total: -428 EUR", -428)).toBe(true);
    expect(statesFigure("an outflow of 428.00 EUR", -428)).toBe(true);
    expect(statesFigure("Total: 1,234.50", 1234.5)).toBe(true);
  });
  it("rejects another figure, an id or a date that only look alike", () => {
    expect(statesFigure("Total: -297.5 EUR", -428)).toBe(false);
    expect(statesFigure("BK-428 on 2026-04-28", 428)).toBe(false);
  });
});

describe("lostChecks: a recompile from a wrong agent report", () => {
  it("is refused when it loses the calculations or the selection rule", async () => {
    const { readTrace } = await import("@hotpathrun/shared");
    const { compileTraceDetailed } = await import("../src/compiler.js");
    const { lostChecks, markCalculations } = await import("../src/index.js");
    const trace = await readTrace(
      path.resolve(
        fixtures,
        "../../../packages/compiler/test/fixtures/bank-reconciliation.jsonl",
      ),
    );
    const build = (t: typeof trace) => {
      const { workflow, recorded } = compileTraceDetailed(t, "x");
      return markCalculations(workflow, recorded, t.meta.inputs);
    };
    const good = build(trace);
    // what the drift-suite fallback agent sent: a matched line, total 484
    const send = trace.calls.at(-1)!;
    const wrongText =
      "Unmatched bank lines:\n- BK-1004: -279 EUR\n- BK-1006: 540 EUR\n- BK-1007: -18.5 EUR\n\nTotal unmatched amount: 484 EUR.";
    const wrong = build({
      ...trace,
      calls: [
        ...trace.calls.slice(0, -1),
        { ...send, args: { ...send.args, text: wrongText } },
      ],
    });
    expect(lostChecks(good, wrong)).toEqual([
      "the figures code calculates in s5",
      "the rule that selects the items of s5",
    ]);
    expect(lostChecks(good, good)).toEqual([]);
  });
});

describe("figures written with trailing zeros (a Sonnet recording)", () => {
  it("learns them as well", async () => {
    const sonnet =
      "Unmatched bank lines (no ledger entry):\n" +
      "1) BK-1004 - AWS invoice - -310.00 USD x 0.9 = -279.00 EUR\n" +
      "2) BK-1007 - Bank fee - -18.50 EUR\n" +
      "Total unmatched: -297.50 EUR.";
    const calcs = learnCalculations(
      sonnet,
      await day("default", ["USD", "GBP"]),
    );
    const total = calcs.find((c) => c.recorded === -297.5);
    expect(total?.line).toBe("Total unmatched: <calculated> EUR.");
    const today = computeFigures(total!, await day("new-data", ["USD", "USD"]));
    expect(today?.[0]?.value).toBe(-428);
  });
});

describe("an unselected item named in passing (the full Sonnet text)", () => {
  it("still learns the selection and the figures", async () => {
    const sonnet =
      "Bank reconciliation 2026-10-01. Unmatched bank lines (no ledger entry):\n" +
      "1) BK-1004 - AWS invoice - -310.00 USD x 0.9 = -279.00 EUR\n" +
      "2) BK-1007 - Bank fee - -18.50 EUR\n" +
      "Total unmatched: -297.50 EUR.\n" +
      "All other lines (BK-1001, 1002, 1003, 1005, 1006) have a ledger entry by ref.";
    const calcs = learnCalculations(
      sonnet,
      await day("default", ["USD", "GBP"]),
    );
    const total = calcs.find((c) => c.op === "sum");
    expect(total?.selection?.rules).toEqual([
      {
        kind: "notIn",
        field: "ref",
        other: "steps.s2.result",
        otherField: "ref",
      },
    ]);
    const today = computeFigures(total!, await day("new-data", ["USD", "USD"]));
    expect(today?.[0]?.value).toBe(-428);
  });

  it("does not set aside an item named on the same line as the others", async () => {
    // BK-1001 sits in the list itself: then it is part of the selection, and no rule fits
    const text =
      "Unmatched: BK-1001, BK-1004, BK-1007. Total unmatched: -297.50 EUR.";
    const calcs = learnCalculations(text, await day("default", ["USD", "GBP"]));
    expect(calcs.find((c) => c.selection)).toBeUndefined();
  });
});

describe("list numbering", () => {
  it("is not a figure: '2) BK-1007' is no count of 2", async () => {
    const text =
      "1) BK-1004 - -310.00 USD = -279.00 EUR\n2) BK-1007 - -18.50 EUR\nTotal: -297.50 EUR.";
    const calcs = learnCalculations(text, await day("default", ["USD", "GBP"]));
    expect(calcs.find((c) => c.op === "count")).toBeUndefined();
    expect(calcs.find((c) => c.op === "sum")?.recorded).toBe(-297.5);
  });
});
