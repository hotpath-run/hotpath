import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PRIVACY_LINE,
  formatScanHtml,
  formatScanJson,
  formatScanText,
  loadRuns,
  parsePriceArg,
  scanRuns,
  toImportedRun,
  type ImportedRun,
} from "../src/index.js";

const SECRET = "ana-secret@example.com";

/** One run: tools in order, an argument value that differs per run. */
function run(
  i: number,
  tools: string[],
  opts: {
    error?: boolean;
    cost?: number;
    model?: string;
    tokens?: number;
  } = {},
): ImportedRun {
  const t0 = Date.parse("2026-11-01T00:00:00Z") + i * 864e5; // one run a day
  return toImportedRun({
    source: "otlp",
    id: `run-${i}`,
    finished: true,
    calls: tools.map((tool, k) => ({
      tool,
      args: { email: `${SECRET}-${i}` },
      result: { ok: true },
      isError: !!opts.error && k === tools.length - 1,
      startMs: t0 + k * 1000,
      endMs: t0 + k * 1000 + 500,
    })),
    usage:
      opts.cost !== undefined || opts.tokens !== undefined
        ? {
            inputTokens: opts.tokens ?? 0,
            outputTokens: 0,
            ...(opts.cost !== undefined ? { costUsd: opts.cost } : {}),
            models: [opts.model ?? "claude-sonnet-5-5"],
          }
        : null,
  });
}

describe("scanRuns", () => {
  const runs = [
    ...[0, 1, 2, 3].map((i) => run(i, ["lookup", "invoices"], { cost: 0.02 })),
    run(4, ["lookup", "invoices"], { error: true, cost: 0.02 }),
    ...[5, 6].map((i) => run(i, ["search", "summarise"], { cost: 0.05 })),
    run(7, []),
  ];
  const r = scanRuns(runs);

  it("counts a path compilable at 3 clean runs, and not at 2", () => {
    expect(r.runs).toBe(8);
    expect(r.distinctPaths).toBe(2);
    expect(r.compilablePaths).toBe(1);
    expect(r.compilableRuns).toBe(4);
    expect(r.potentialHitRate).toBeCloseTo(4 / 8);
    expect(r.hitRateAfterWarmup).toBeCloseTo(1 / 8);
  });

  it("does not count a run with a tool error, or one with no tool call", () => {
    expect(r.failedRuns).toBe(1);
    expect(r.runsWithoutToolCalls).toBe(1);
  });

  it("is labelled an estimate", () => {
    expect(r.label).toBe("estimate");
    expect(formatScanText(r)).toContain("(estimate)");
    expect(formatScanHtml(r)).toContain("estimate");
  });

  it("uses the reported cost and the measured ratio for a monthly saving", () => {
    expect(r.usage.costUsd).toBeCloseTo(0.08);
    // 4 compilable runs over the 6 days between the first and last run
    const days = r.days;
    expect(days).toBeCloseTo(6);
    expect(r.monthly!.agentUsd).toBeCloseTo((0.02 * 4 * 30) / days);
    expect(r.monthly!.savingLowUsd).toBeLessThan(r.monthly!.savingHighUsd);
    expect(r.monthly!.savingHighUsd).toBeLessThan(r.monthly!.agentUsd);
    expect(r.assumptions.limit).toMatch(/two tasks/);
  });

  it("falls back to list prices from tokens when there is no cost", () => {
    const s = scanRuns(
      [0, 1, 2].map((i) =>
        run(i, ["a"], { tokens: 1_000_000, model: "claude-sonnet-5-5-2026" }),
      ),
    );
    // 1M input tokens at $2 per 1M
    expect(s.usage.costUsd).toBeCloseTo(6);
  });

  it("does not guess a price for an unknown model, but takes --price", () => {
    const mk = () =>
      [0, 1, 2].map((i) => run(i, ["a"], { tokens: 1e6, model: "gpt-4.1" }));
    const none = scanRuns(mk());
    expect(none.monthly).toBeNull();
    expect(none.usage.unpricedModels).toEqual(["gpt-4.1"]);
    expect(formatScanText(none)).toContain("No dollar figure");
    const priced = scanRuns(mk(), {
      prices: { "gpt-4.1": parsePriceArg("gpt-4.1=2/8").price },
    });
    expect(priced.usage.costUsd).toBeCloseTo(6);
  });

  it("assumes one day for traces that span less, and says so", () => {
    const s = scanRuns(
      [0, 0, 0].map((_, k) => ({
        ...run(0, ["a"], { cost: 1 }),
        id: String(k),
      })),
    );
    expect(s.daysAssumed).toBe(true);
    expect(formatScanText(s)).toContain("one day is assumed");
  });

  it("never puts an argument value or a run id in any report", () => {
    for (const out of [
      formatScanText(r),
      formatScanJson(r),
      formatScanHtml(r),
    ]) {
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain("run-1");
      expect(out).toContain(PRIVACY_LINE.slice(0, 40));
    }
    expect(formatScanText(r)).toContain("lookup → invoices");
  });

  it("escapes tool names in the HTML", () => {
    const h = scanRuns([0, 1, 2].map((i) => run(i, ["<script>x</script>"])));
    expect(formatScanHtml(h)).not.toContain("<script>x");
  });

  it("handles no runs", () => {
    const e = scanRuns([]);
    expect(e.potentialHitRate).toBe(0);
    expect(formatScanText(e)).toContain("No runs were found");
  });
});

describe("loadRuns", () => {
  it("reads a folder with an export and a bad file, and skips the bad one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scan-"));
    await writeFile(path.join(dir, "bad.json"), "{nope");
    await writeFile(
      path.join(dir, "ls.json"),
      JSON.stringify([
        {
          id: "1",
          trace_id: "t",
          run_type: "tool",
          name: "x",
          start_time: "2026-11-01T00:00:00Z",
          end_time: "2026-11-01T00:00:01Z",
          inputs: {},
          error: null,
        },
      ]),
    );
    const r = await loadRuns(dir);
    expect(r.runs).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
  });

  it("says what to do for a path that does not exist", async () => {
    await expect(
      loadRuns(path.join(os.tmpdir(), "nope-scan-xyz")),
    ).rejects.toThrow(/trace export file or a folder/);
  });
});
