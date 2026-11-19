// Is the guard safe on a selective report with calculated figures? The
// bank-reconciliation recording (checked in) reports the bank lines missing
// from the ledger and their total in EUR. On a new day, a correct report must
// pass, and every wrong one must be rejected: a missing or extra unmatched
// line, a wrong or copied total. Measured before this guard: qwen3:1.7b sent
// the recorded total -297.5 in 20 of 20 replays, citing 2 of 3 unmatched lines.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { compileTraceDetailed, learnCalculations } from "@hotpathrun/compiler";
import { readTrace, type TemplateContext } from "@hotpathrun/shared";

import { figureProblems, todaysFigures } from "../src/checks.js";
import { checkGrounding, checkStale } from "../src/runtime.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const trace = await readTrace(
  path.join(
    repoRoot,
    "packages/compiler/test/fixtures/bank-reconciliation.jsonl",
  ),
);
const finance = JSON.parse(
  await readFile(
    path.join(repoRoot, "examples/demo-tools/fixtures/new-data/finance.json"),
    "utf8",
  ),
);
// 2026-10-02 as the compiled steps see it: s3 and s4 read the rates of the
// currencies at lines 1 and 5 (both USD today)
const ctx: TemplateContext = {
  inputs: { date: "2026-10-02" },
  steps: {
    s1: { result: { page: 1, lines: finance.pages.flat() } },
    s2: { result: finance.ledger },
    s3: { result: { currency: "USD", eur_per_unit: 0.9 } },
    s4: { result: { currency: "USD", eur_per_unit: 0.9 } },
  },
};

function build(selectionRules: boolean) {
  if (!selectionRules) process.env.HOTPATH_SELECTION_RULES = "0";
  try {
    const { workflow, recorded } = compileTraceDetailed(trace, "x");
    const llm = workflow.steps.find((s) => s.type === "llm");
    if (llm?.type !== "llm") throw new Error("no llm step");
    const rctx: TemplateContext = { inputs: trace.meta.inputs, steps: {} };
    for (const r of recorded) rctx.steps[r.id] = { result: r.result } as never;
    return { guard: llm.guard, calcs: learnCalculations(llm.example, rctx) };
  } finally {
    delete process.env.HOTPATH_SELECTION_RULES;
  }
}
afterEach(() => delete process.env.HOTPATH_SELECTION_RULES);

const before = build(false); // positions only, no calculations
const now = build(true);

/** null = accepted; otherwise why */
function verdict(
  b: typeof now,
  text: string,
  withFigures: boolean,
): string | null {
  const missing = checkGrounding(b.guard.grounding, ctx, text);
  const stale = checkStale(b.guard.exampleFacts, ctx, text);
  const figs = withFigures
    ? figureProblems(todaysFigures(b.calcs, ctx), ctx, text)
    : { missing: [], stale: [] };
  const all = [...missing, ...stale, ...figs.missing, ...figs.stale];
  return all.length === 0 ? null : all.join("; ");
}

const CORRECT = [
  "Reconciliation Report for 2026-10-02:",
  "",
  "Unmatched Bank Lines:",
  "- BK-2002: Google Workspace (-120 USD = -108 EUR)",
  "- BK-2006: Atlassian licences (-250 USD = -225 EUR)",
  "- BK-2007: Refund Zielona Kawa (-95 EUR)",
  "",
  "Total unmatched amount: -428 EUR.",
].join("\n");

describe("bank-reconciliation guard on a new day", () => {
  it("accepts a correct report, old and new", () => {
    expect(verdict(before, CORRECT, false)).toBeNull();
    expect(verdict(now, CORRECT, true)).toBeNull();
  });

  it("accepts the total written another way", () => {
    expect(
      verdict(
        now,
        CORRECT.replace("-428 EUR.", "428.00 EUR (outgoing)."),
        true,
      ),
    ).toBeNull();
  });

  // what qwen3:1.7b sent 20 times out of 20 (measured 2026-11-16)
  const QWEN = [
    "Unmatched Bank Lines:",
    "- BK-2002: Google Workspace (-120 USD = -108 EUR)",
    "- BK-2003: Courier DHL (-85.5 EUR)",
    "",
    "Total unmatched amount: -297.5 EUR.",
  ].join("\n");

  it("the old guard let the measured wrong report through; the new one stops it", () => {
    expect(verdict(before, QWEN, false)).toBeNull();
    const why = verdict(now, QWEN, true);
    expect(why).toMatch(/BK-2006/);
    expect(why).toMatch(/BK-2007/);
    expect(why).toMatch(/428/); // today's total missing
    expect(why).toMatch(/297\.5/); // the recorded total copied
  });

  it.each([
    [
      "an unmatched line left out",
      CORRECT.replace(/- BK-2006.*\n/, ""),
      /BK-2006/,
    ],
    [
      "a matched line reported instead of an unmatched one",
      CORRECT.replace("BK-2007: Refund Zielona Kawa", "BK-2003: Courier DHL"),
      /BK-2007/,
    ],
    ["a wrong total", CORRECT.replace("-428", "-332"), /428/],
    ["the recorded total", CORRECT.replace("-428", "-297.5"), /297\.5/],
    ["no total", CORRECT.replace(/\nTotal.*$/, ""), /428/],
    [
      "a wrong converted amount",
      CORRECT.replace("-225 EUR", "-250 EUR"),
      /225/,
    ],
  ])("rejects %s", (_name, text, why) => {
    expect(verdict(now, text, true)).toMatch(why);
  });

  it("asks for nothing when no line is unmatched today", () => {
    const allMatched: TemplateContext = {
      ...ctx,
      steps: {
        ...ctx.steps,
        s2: {
          result: finance.pages
            .flat()
            .map((l: { ref: string }) => ({ ref: l.ref, amount_eur: 0 })),
        },
      },
    };
    const missing = checkGrounding(
      now.guard.grounding,
      allMatched,
      "All bank lines are matched. Total unmatched amount: 0 EUR.",
    );
    expect(missing).toEqual([]);
  });
});

describe("a currency the recording never saw", () => {
  it("is drift, not a guess: the CHF rate was never read", async () => {
    const { missingRates } = await import("@hotpathrun/shared");
    const chf: TemplateContext = {
      ...ctx,
      steps: {
        ...ctx.steps,
        s1: {
          result: {
            page: 1,
            lines: finance.pages
              .flat()
              .map((l: { ref: string }) =>
                l.ref === "BK-2007" ? { ...l, currency: "CHF" } : l,
              ),
          },
        },
      },
    };
    const total = now.calcs.find((c) => c.op === "sum")!;
    expect(missingRates(total, chf)).toEqual(["CHF"]);
    expect(missingRates(total, ctx)).toEqual([]);
    // and nothing is claimed for it: no figure the model could be held to
    expect(todaysFigures([total], chf)).toEqual([]);
  });
});
