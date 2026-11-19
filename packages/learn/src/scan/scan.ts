// The savings scan: group imported runs by path signature (the same one
// hotpath learn uses), count the paths that repeat cleanly, and put a rough
// price on what they cost an agent today. Pure: no files, no network, no model.
// Only tool names and argument shapes leave this module, never argument values.
import { DEFAULT_HOT_AFTER } from "../paths.js";
import { pathSignature } from "../signature.js";

import { priceOf, type ModelPrice } from "./prices.js";
import type { ImportedRun } from "./types.js";

/**
 * Replay cost as a share of the agent's cost, measured in docs/CLAIMS.md
 * (morning-brief, Claude, 2026-11-16): Haiku replay $0.0006 against a Sonnet
 * agent run $0.0179 when no run falls back; about $0.0023 when one in ten does.
 */
export const REPLAY_SHARE = {
  noFallback: 0.0006 / 0.0179,
  tenPercentFallback: 0.0023 / 0.0179,
};

export const SAVING_LIMIT =
  "The replay-to-agent cost ratio was measured on two tasks (a Sonnet agent against a Haiku replay, 10 runs each, docs/CLAIMS.md). Your agent, model and tasks may differ, and a run that falls back to the agent costs more than one that does not.";

export interface ScanOptions {
  /** clean runs of one path that make it compilable (default 3) */
  hotAfter?: number;
  /** days the traces cover; default: from the runs' own times, at least 1 */
  days?: number;
  /** extra model prices (USD per 1M tokens), tried before the list */
  prices?: Record<string, ModelPrice>;
  /** what one agent run costs, for traces without usage */
  runCostUsd?: number;
}

export interface PathSummary {
  id: string;
  /** tool names and argument shapes: `tool!(arg:kind, …)` */
  steps: string[];
  runs: number;
  cleanRuns: number;
  compilable: boolean;
  avgCostUsd: number | null;
}

export interface ScanResult {
  /** "estimate": every number below is one */
  label: "estimate";
  sources: Record<string, number>;
  hotAfter: number;
  runs: number;
  runsWithoutToolCalls: number;
  failedRuns: number;
  distinctPaths: number;
  compilablePaths: number;
  /** clean runs on compilable paths */
  compilableRuns: number;
  /** compilableRuns / runs: the hit rate once every path is compiled */
  potentialHitRate: number;
  /** same, but the first hotAfter runs of each path still go to the agent */
  hitRateAfterWarmup: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** compilable runs with a known cost / without */
    costKnownRuns: number;
    costUnknownRuns: number;
    costUsd: number;
    models: string[];
    /** models seen with tokens but no known price */
    unpricedModels: string[];
  };
  /** callable runs where no tool result was in the export */
  runsWithoutResults: number;
  topPaths: PathSummary[];
  days: number;
  daysAssumed: boolean;
  /** null when no cost is known for any compilable run */
  monthly: null | {
    agentUsd: number;
    savingLowUsd: number;
    savingHighUsd: number;
    /** cost of the compilable runs was filled in from the known ones */
    extrapolated: boolean;
  };
  assumptions: {
    replayShareLow: number;
    replayShareHigh: number;
    limit: string;
  };
}

function runCost(
  run: ImportedRun,
  options: ScanOptions,
  unpriced: Set<string>,
): number | null {
  const u = run.usage;
  if (!u) return options.runCostUsd ?? null;
  if (u.costUsd !== undefined) return u.costUsd;
  const model = u.models[0];
  const price = model ? priceOf(model, options.prices) : null;
  if (!price) {
    if (model) unpriced.add(model);
    return options.runCostUsd ?? null;
  }
  return (
    (u.inputTokens * price.inPer1M + u.outputTokens * price.outPer1M) /
    1_000_000
  );
}

const hasFailure = (
  run: ImportedRun,
  calls: { calls: { isError: boolean }[] }[],
) =>
  run.trace.open === true || calls.some((c) => c.calls.some((x) => x.isError));

export function scanRuns(
  runs: ImportedRun[],
  options: ScanOptions = {},
): ScanResult {
  const hotAfter = Math.max(1, options.hotAfter ?? DEFAULT_HOT_AFTER);
  const sources: Record<string, number> = {};
  const unpriced = new Set<string>();
  const groups = new Map<
    string,
    {
      id: string;
      steps: string[];
      runs: number;
      clean: Array<{ run: ImportedRun; cost: number | null }>;
    }
  >();
  let noCalls = 0;
  let failed = 0;
  let withoutResults = 0;
  for (const run of runs) {
    sources[run.source] = (sources[run.source] ?? 0) + 1;
    const sig = pathSignature(run.trace);
    if (sig.calls.length === 0) {
      noCalls++;
      continue;
    }
    if (run.trace.calls.every((c) => c.result === undefined)) withoutResults++;
    const group = groups.get(sig.key) ?? {
      id: sig.id,
      steps: sig.steps,
      runs: 0,
      clean: [],
    };
    group.runs++;
    if (hasFailure(run, sig.calls)) failed++;
    else group.clean.push({ run, cost: runCost(run, options, unpriced) });
    groups.set(sig.key, group);
  }

  const all = [...groups.values()];
  const compilable = all.filter((g) => g.clean.length >= hotAfter);
  const hot = compilable.flatMap((g) => g.clean);
  const compilableRuns = hot.length;
  const afterWarmup = compilable.reduce(
    (n, g) => n + g.clean.length - hotAfter,
    0,
  );

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let known = 0;
  const models = new Map<string, number>();
  for (const { run, cost } of hot) {
    inputTokens += run.usage?.inputTokens ?? 0;
    outputTokens += run.usage?.outputTokens ?? 0;
    for (const m of run.usage?.models ?? [])
      models.set(m, (models.get(m) ?? 0) + 1);
    if (cost !== null) {
      known++;
      costUsd += cost;
    }
  }

  const times = runs
    .map((r) => Date.parse(r.trace.meta.startedAt))
    .filter((t) => t > 0);
  const spanDays =
    times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 864e5 : 0;
  const daysAssumed = options.days === undefined && spanDays < 1;
  const days = Math.max(1, options.days ?? spanDays);

  let monthly: ScanResult["monthly"] = null;
  if (known > 0) {
    const perMonth = 30 / days;
    const agentUsd = (costUsd / known) * compilableRuns * perMonth;
    monthly = {
      agentUsd,
      savingLowUsd: agentUsd * (1 - REPLAY_SHARE.tenPercentFallback),
      savingHighUsd: agentUsd * (1 - REPLAY_SHARE.noFallback),
      extrapolated: known < compilableRuns,
    };
  }

  const topPaths: PathSummary[] = all
    .map((g) => {
      const costs = g.clean.flatMap((c) => (c.cost === null ? [] : [c.cost]));
      return {
        id: g.id,
        steps: g.steps,
        runs: g.runs,
        cleanRuns: g.clean.length,
        compilable: g.clean.length >= hotAfter,
        avgCostUsd: costs.length
          ? costs.reduce((a, b) => a + b, 0) / costs.length
          : null,
      };
    })
    .sort((a, b) => b.cleanRuns - a.cleanRuns || a.id.localeCompare(b.id))
    .slice(0, 10);

  return {
    label: "estimate",
    sources,
    hotAfter,
    runs: runs.length,
    runsWithoutToolCalls: noCalls,
    failedRuns: failed,
    distinctPaths: all.length,
    compilablePaths: compilable.length,
    compilableRuns,
    potentialHitRate: runs.length ? compilableRuns / runs.length : 0,
    hitRateAfterWarmup: runs.length ? afterWarmup / runs.length : 0,
    usage: {
      inputTokens,
      outputTokens,
      costKnownRuns: known,
      costUnknownRuns: compilableRuns - known,
      costUsd,
      models: [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m),
      unpricedModels: [...unpriced].sort(),
    },
    runsWithoutResults: withoutResults,
    topPaths,
    days,
    daysAssumed,
    monthly,
    assumptions: {
      replayShareLow: REPLAY_SHARE.noFallback,
      replayShareHigh: REPLAY_SHARE.tenPercentFallback,
      limit: SAVING_LIMIT,
    },
  };
}
