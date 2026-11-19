// Pure helpers for `pnpm bench` (SPEC §7); process/file I/O lives in index.ts.

import { formatMs, mentions } from "@hotpathrun/shared";

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface Timing {
  durationMs: number;
  costUsd: number;
  /** hotpath runs only: MCP server startup, tool steps, llm steps (ms) */
  connectMs?: number;
  toolMs?: number;
  llmMs?: number;
  /** time spent waiting on rate-limit retries; included in durationMs */
  rateLimitWaitMs?: number;
}

export interface Split {
  connectMs?: number;
  toolMs?: number;
  llmMs?: number;
}

export interface ScenarioResult {
  scenario: string;
  pass: boolean;
  /** the comparison agent run; null when there is none (drift) or it was skipped */
  agent: Timing | null;
  /** the hotpath run (for drift: the fallback run incl. the agent) */
  hotpath: Timing;
  /** drift only: the follow-up run on the recompiled workflow */
  recovered?: { durationMs: number; rateLimitWaitMs?: number } & Split;
  match: boolean;
  fallback: boolean;
  notes?: string[];
  /** failed because the model provider did (429, 5xx, connection), not the engine */
  providerError?: boolean;
}

/** mustMention strings the text lacks (typographic variants count as present). */
export function missingMentions(text: string, mustMention: string[]): string[] {
  return mustMention.filter((m) => !mentions(text, m));
}

/** `tool.arg` keys whose value comes from an llm step, so they differ every run. */
export function llmArgKeys(
  steps: Array<{ type: string; tool?: string; args?: Record<string, unknown> }>,
): Set<string> {
  const keys = new Set<string>();
  for (const step of steps) {
    if (step.type !== "tool" || !step.args || !step.tool) continue;
    for (const [arg, value] of Object.entries(step.args)) {
      if (
        typeof value === "string" &&
        /^\{\{steps\.[^.}]+\.output\}\}$/.test(value)
      ) {
        keys.add(`${step.tool}.${arg}`);
      }
    }
  }
  return keys;
}

/**
 * The calls a replay should make: the recorded ones without the failed ones,
 * which the compiler drops on purpose (a replay must not repeat a mistake).
 */
export function expectedCalls(
  calls: Array<ToolCall & { isError?: boolean }>,
): ToolCall[] {
  return calls
    .filter((c) => !c.isError)
    .map((c) => ({ tool: c.tool, args: c.args }));
}

/** null when the sequences match, else a one-line reason. */
export function sequenceMatches(
  actual: ToolCall[],
  expected: ToolCall[],
  ignore: Set<string>,
): string | null {
  if (actual.length !== expected.length) {
    return `expected ${expected.length} calls, got ${actual.length}`;
  }
  // The same reads in another order are fine, as long as the messages sent
  // are the same and in the same order: a paginated read is fetched in one go,
  // where the agent may have looked at something else between two pages.
  const key = (c: ToolCall) =>
    JSON.stringify([
      c.tool,
      Object.keys(c.args)
        .filter((k) => !ignore.has(`${c.tool}.${k}`))
        .sort()
        .map((k) => [k, c.args[k]]),
    ]);
  const isSend = (c: ToolCall) => c.tool === "send_message";
  const reads = (calls: ToolCall[]) =>
    calls
      .filter((c) => !isSend(c))
      .map(key)
      .sort()
      .join("|");
  const sends = (calls: ToolCall[]) => calls.filter(isSend).map(key).join("|");
  if (reads(actual) === reads(expected) && sends(actual) === sends(expected)) {
    return null;
  }
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    if (a.tool !== e.tool) {
      return `call ${i + 1}: expected ${e.tool}, got ${a.tool}`;
    }
    const keys = new Set([...Object.keys(a.args), ...Object.keys(e.args)]);
    for (const key of keys) {
      if (ignore.has(`${e.tool}.${key}`)) continue;
      if (JSON.stringify(a.args[key]) !== JSON.stringify(e.args[key])) {
        return `call ${i + 1} (${e.tool}): arg ${key} is ${JSON.stringify(a.args[key])}, expected ${JSON.stringify(e.args[key])}`;
      }
    }
  }
  return null;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const dollars = (usd: number) => `$${usd.toFixed(4)}`;
/** run time with the rate-limit waiting taken out (reported beside it instead) */
const netMs = (t: { durationMs: number; rateLimitWaitMs?: number }) =>
  Math.max(0, t.durationMs - (t.rateLimitWaitMs ?? 0));

const pair = (t: Timing) =>
  `${seconds(netMs(t))} / ${dollars(t.costUsd)}` +
  ((t.rateLimitWaitMs ?? 0) > 0
    ? ` (+${seconds(t.rateLimitWaitMs ?? 0)} rate-limit wait)`
    : "");

/** "0.3s + 45ms + 1.1s": server startup + deterministic tool steps + llm steps. */
function splitCell(s: Split): string {
  if (
    s.connectMs === undefined ||
    s.toolMs === undefined ||
    s.llmMs === undefined
  ) {
    return "-";
  }
  return `${formatMs(s.connectMs)} + ${formatMs(s.toolMs)} + ${formatMs(s.llmMs)}`;
}

export function formatTable(rows: ScenarioResult[]): string {
  const header = [
    "scenario",
    "agent time / cost",
    "hotpath time / cost",
    "startup + tools + llm",
    "speedup",
    "cheaper",
    "match",
    "fallback",
  ];
  const body = rows.map((r) => {
    const hotpath = r.recovered
      ? `${pair(r.hotpath)} → ${seconds(netMs(r.recovered))}`
      : pair(r.hotpath);
    const comparable = r.agent && !r.recovered;
    const speedup = comparable
      ? `${Math.round(netMs(r.agent!) / Math.max(netMs(r.hotpath), 1))}x`
      : "-";
    const cheaper =
      comparable && r.hotpath.costUsd > 0
        ? `${Math.round(r.agent!.costUsd / r.hotpath.costUsd)}x`
        : "-";
    return [
      r.scenario,
      r.agent ? pair(r.agent) : "-",
      hotpath,
      splitCell(r.recovered ?? r.hotpath),
      speedup,
      cheaper,
      r.pass && r.match ? "✅" : "❌",
      r.fallback ? "yes → recompiled" : "no",
    ];
  });
  const all = [header, ...body];
  const widths = header.map((_, i) =>
    Math.max(...all.map((row) => row[i].length)),
  );
  return all
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export interface PassRate {
  scenario: string;
  passes: number;
  runs: number;
  /** runs lost to the model provider (429, 5xx): not counted in runs */
  excluded?: number;
}

/** Per-scenario pass counts over several bench runs, in first-run order. */
export function passRates(runs: ScenarioResult[][]): PassRate[] {
  const rates = new Map<string, PassRate>();
  for (const run of runs) {
    for (const r of run) {
      const rate = rates.get(r.scenario) ?? {
        scenario: r.scenario,
        passes: 0,
        runs: 0,
      };
      // a provider outage says nothing about the engine: reported, not counted
      if (r.providerError && !(r.pass && r.match)) {
        rate.excluded = (rate.excluded ?? 0) + 1;
        rates.set(r.scenario, rate);
        continue;
      }
      rate.runs++;
      if (r.pass && r.match) rate.passes++;
      rates.set(r.scenario, rate);
    }
  }
  return [...rates.values()];
}

export function formatPassRates(rates: PassRate[]): string {
  const header = ["scenario", "passed", "pass rate"];
  const body = rates.map((r) => [
    r.scenario,
    `${r.passes}/${r.runs}`,
    `${Math.round((100 * r.passes) / Math.max(r.runs, 1))}%`,
  ]);
  const all = [header, ...body];
  const widths = header.map((_, i) =>
    Math.max(...all.map((row) => row[i].length)),
  );
  return all
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** The suite's seven office tasks (examples/demo-tools/src/office.ts). */
export const OFFICE_TASKS = [
  "ticket-pages",
  "customer-lookup",
  "long-report",
  "flaky-sales",
  "two-places",
  "invoice-total",
  "meeting-times",
];

/** Finance tasks (examples/demo-tools/src/finance.ts), also part of the suite. */
export const FINANCE_TASKS = ["bank-reconciliation"];

/** Pass counts per task (scenario names are "<task>/<scenario>"), then the total. */
export function formatSuiteSummary(rates: PassRate[]): string {
  const byTask = new Map<string, { passes: number; runs: number }>();
  for (const r of rates) {
    const task = r.scenario.split("/")[0]!;
    const t = byTask.get(task) ?? { passes: 0, runs: 0 };
    t.passes += r.passes;
    t.runs += r.runs;
    byTask.set(task, t);
  }
  const total = { passes: 0, runs: 0 };
  const rows = [...byTask].map(([task, t]) => {
    total.passes += t.passes;
    total.runs += t.runs;
    return [
      task,
      `${t.passes}/${t.runs}`,
      `${Math.round((100 * t.passes) / Math.max(t.runs, 1))}%`,
    ];
  });
  rows.push([
    "TOTAL",
    `${total.passes}/${total.runs}`,
    `${Math.round((100 * total.passes) / Math.max(total.runs, 1))}%`,
  ]);
  const all = [["task", "scenarios passed", "rate"], ...rows];
  const widths = all[0]!.map((_, i) =>
    Math.max(...all.map((row) => row[i]!.length)),
  );
  return all
    .map((row) =>
      row
        .map((c, i) => c.padEnd(widths[i]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
