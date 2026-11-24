import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { latestTraceFile } from "@hotpathrun/compiler";
import { workflowSchema, type Workflow } from "@hotpathrun/shared";

import { missingMentions } from "./lib.js";
import {
  agentProviderFailure,
  isModelProviderFailure,
} from "./rejections-lib.js";
import {
  correctnessProblems,
  mean,
  percentile,
  workflowPreservation,
  type Exact,
} from "./measure-lib.js";

// `pnpm bench:measure --task T [--runs N] [--drift K] [--record]`
//
// One record per run in out/measure-<id>.jsonl, every scenario in the same
// shape (run id, tokens, cost, timing split), then p50/p95 per scenario.
//
//   wall      the whole `hotpath run` process, as a person would wait for it
//   engine    what the runtime measured inside it: startup (MCP server), tool
//             steps, model calls (rate-limit waits are in `wait`, not hidden)
//
// Replays use --no-fallback: a run that drifts is counted as a failure that
// needs recovery, and costs no agent call. `--drift K` then measures recovery
// itself: K times, the compiled workflow is restored, run on changed data with
// the fallback, and the recompiled workflow is compared with the old one.
// `--record` records a fresh run with the agent first (one agent call).

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const outDir = path.join(repoRoot, "out");
const argv = process.argv.slice(2);
const flag = (name: string) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const task = flag("--task") ?? "bank-reconciliation";
const runs = Number(flag("--runs") ?? 20);
const driftRuns = Number(flag("--drift") ?? 0);
const record = argv.includes("--record");
const scenarioList = (flag("--scenarios") ?? "same-data,new-data")
  .split(",")
  .filter((x) => x && x !== "none");
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error("--runs needs a positive integer, e.g. --runs 20");
}

// `--drift-set drift-new-enum` runs the drift scenario on another fixture set (the drift suite)
const driftSet = flag("--drift-set") ?? "drift";
const SETS: Record<string, string> = {
  "same-data": "default",
  "new-data": "new-data",
  drift: driftSet,
  "drift-after-recompile": driftSet,
};

interface Expected {
  date: string;
  mustMention: string[];
  exact?: Exact;
}

interface Record_ {
  runId: string;
  seq: number;
  task: string;
  scenario: string;
  ok: boolean;
  fallback: boolean;
  recompiled: boolean;
  driftReason?: string;
  wallMs: number;
  engineMs: number;
  startupMs: number;
  toolMs: number;
  llmMs: number;
  waitMs: number;
  llmCalls: number;
  reusedSteps: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  agent?: {
    llmCalls: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    durationMs: number;
  };
  /** what was sent, so every verdict can be checked by reading it */
  sent: string;
  mentionsMissing: string[];
  correctnessProblems: string[] | "not defined";
  outputTail?: string;
  /** the model provider failed (429, 5xx, connection): not an engine result */
  providerError?: boolean;
  /** which step and guard stopped the run, and why a first answer was asked again */
  driftStep?: string;
  reason?: string;
  firstAttemptIssues?: string[];
  /** HOTPATH_KEEP_REJECTED=1: the text a guard rejected, every attempt */
  rejectedOutputs?: string[];
  preservation?: ReturnType<typeof workflowPreservation>;
}

/** The line that says why a run stopped: a drift, else the first error. */
function failureLine(output: string): string | undefined {
  const lines = output.split("\n");
  return (
    lines.find((l) => /drift at/i.test(l)) ??
    lines.find((l) => /error|failed|\b(429|5\d\d)\b/i.test(l))
  )?.slice(0, 160);
}

function exec(
  args: string[],
  fixtures: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; output: string; wallMs: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", ...args], {
      cwd: repoRoot,
      env: { ...process.env, DEMO_FIXTURES: fixtures, ...extraEnv },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, wallMs: Date.now() - started });
    });
  });
}

const cli = (
  args: string[],
  fixtures: string,
  extraEnv: Record<string, string> = {},
) => exec(["packages/cli/src/index.ts", ...args], fixtures, extraEnv);

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path.join(outDir, file), "utf8")) as T;
  } catch {
    return null;
  }
}

async function expectedFor(set: string): Promise<Expected> {
  const file = path.join(
    repoRoot,
    "examples/demo-tools/fixtures",
    set,
    task === "morning-brief" ? "expected.json" : `${task}.expected.json`,
  );
  return JSON.parse(await readFile(file, "utf8")) as Expected;
}

async function sentText(): Promise<string> {
  const m = await readJson<Array<{ text: string }>>("messages.json");
  return (m ?? []).map((x) => x.text).join("\n\n");
}

const workflowFile = path.join(repoRoot, "workflows", `${task}.json`);
const loadWorkflow = async (): Promise<Workflow> =>
  workflowSchema.parse(JSON.parse(await readFile(workflowFile, "utf8")));

interface RunMetricsFile {
  durationMs: number;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  fallback: boolean;
  recompiled?: boolean;
  reason?: string;
  driftStep?: string;
  connectMs?: number;
  toolMs?: number;
  llmMs?: number;
  rateLimitWaitMs?: number;
  reusedSteps?: string[];
  firstAttemptIssues?: string[];
  rejectedOutputs?: string[];
}

const runId = randomUUID().slice(0, 8);
const outFile = path.join(outDir, `measure-${runId}.jsonl`);
let seq = 0;

async function one(scenario: string, extraArgs: string[]): Promise<Record_> {
  const set = SETS[scenario] ?? "default";
  const expected = await expectedFor(set);
  await rm(path.join(outDir, "messages.json"), { force: true });
  await rm(path.join(outDir, "agent-run.json"), { force: true });
  await rm(path.join(outDir, "hotpath-run.json"), { force: true });
  // each run is a new day: without this, a run that stopped after its first
  // message makes the next one skip that message (crash journal), and the
  // bench scored the half-sent run as a wrong report (two-places, 2026-11-18)
  await rm(path.join(repoRoot, ".hotpath", "journal", task), {
    recursive: true,
    force: true,
  });
  const run = await cli(
    ["run", task, "--input", `date=${expected.date}`, ...extraArgs],
    set,
    // Data seen before reuses the saved answer (no model call). Only the same-data
    // scenario is meant to; a new day never repeats, so every other run asks the model.
    scenario === "same-data" ? {} : { HOTPATH_REUSE: "0" },
  );
  const m = await readJson<RunMetricsFile>("hotpath-run.json");
  const agent = await readJson<NonNullable<Record_["agent"]>>("agent-run.json");
  const text = await sentText();
  const failed = run.code !== 0 || m === null;
  const r: Record_ = {
    runId,
    seq: ++seq,
    task,
    scenario,
    ok: !failed && text.length > 0,
    fallback: m?.fallback ?? false,
    recompiled: m?.recompiled ?? false,
    ...(failed
      ? {
          driftReason: failureLine(run.output),
          // the end of the output, so a failure with no drift line (a provider
          // error, a crash) can still be read and classified afterwards
          outputTail: run.output
            .split("\n")
            .filter((l) => l.trim() && !/punycode|trace-deprecation/.test(l))
            .slice(-6)
            .join("\n")
            .slice(-600),
          providerError:
            (isModelProviderFailure(run.output) && !m?.driftStep) ||
            agentProviderFailure(run.output),
        }
      : {}),
    wallMs: run.wallMs,
    engineMs: m?.durationMs ?? 0,
    startupMs: m?.connectMs ?? 0,
    toolMs: m?.toolMs ?? 0,
    llmMs: m?.llmMs ?? 0,
    waitMs: m?.rateLimitWaitMs ?? 0,
    llmCalls: m?.llmCalls ?? 0,
    reusedSteps: m?.reusedSteps?.length ?? 0,
    promptTokens: m?.promptTokens ?? 0,
    completionTokens: m?.completionTokens ?? 0,
    costUsd: m?.costUsd ?? 0,
    ...(agent ? { agent } : {}),
    ...(m?.driftStep ? { driftStep: m.driftStep, reason: m.reason } : {}),
    ...(m?.firstAttemptIssues
      ? { firstAttemptIssues: m.firstAttemptIssues }
      : {}),
    ...(m?.rejectedOutputs ? { rejectedOutputs: m.rejectedOutputs } : {}),
    sent: text,
    mentionsMissing: text ? missingMentions(text, expected.mustMention) : [],
    correctnessProblems: expected.exact
      ? text
        ? correctnessProblems(text, expected.exact)
        : ["nothing was sent"]
      : "not defined",
  };
  await appendFile(outFile, `${JSON.stringify(r)}\n`);
  return r;
}

const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
const usd = (x: number) => `$${x.toFixed(4)}`;

function summarize(scenario: string, rs: Record_[]): string[] {
  const ok = rs.filter((r) => r.ok);
  const correct = ok.filter(
    (r) =>
      r.mentionsMissing.length === 0 &&
      (r.correctnessProblems === "not defined" ||
        r.correctnessProblems.length === 0),
  );
  const mentioned = ok.filter((r) => r.mentionsMissing.length === 0);
  const wall = rs.map((r) => r.wallMs);
  const eng = ok.map((r) => r.engineMs);
  return [
    scenario,
    String(rs.length),
    `${ok.length}`,
    `${mentioned.length}`,
    `${correct.length}`,
    `${rs.filter((r) => r.llmCalls === 0 && r.ok).length}`,
    `${s(percentile(wall, 50))} / ${s(percentile(wall, 95))}`,
    `${s(percentile(eng, 50))} / ${s(percentile(eng, 95))}`,
    `${mean(ok.map((r) => r.promptTokens)).toFixed(0)} / ${mean(ok.map((r) => r.completionTokens)).toFixed(0)}`,
    `${usd(mean(ok.map((r) => r.costUsd)))}`,
  ];
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  if (record) {
    console.log(`[${runId}] recording ${task} with the agent (one agent run)…`);
    await rm(path.join(repoRoot, "traces", task), {
      recursive: true,
      force: true,
    });
    await rm(workflowFile, { force: true });
    const expected = await expectedFor("default");
    const agentRun = await exec(
      [
        "examples/demo-agent/src/index.ts",
        "--task",
        task,
        "--date",
        expected.date,
      ],
      "default",
    );
    if (agentRun.code !== 0)
      throw new Error(`agent run failed:\n${agentRun.output}`);
    const agentMetrics = await readJson<Record_["agent"]>("agent-run.json");
    console.log(
      `[${runId}] agent: ${agentMetrics?.llmCalls} calls, ${agentMetrics?.promptTokens} in / ${agentMetrics?.completionTokens} out, ${usd(agentMetrics?.costUsd ?? 0)}, ${s(agentMetrics?.durationMs ?? 0)}`,
    );
    const trace = await latestTraceFile(task);
    const compiled = await cli(
      ["compile", task, "--trace", trace, "--yes"],
      "default",
    );
    if (compiled.code !== 0)
      throw new Error(`compile failed:\n${compiled.output}`);
  }
  const baseline = await loadWorkflow();
  const baselineText = await readFile(workflowFile, "utf8");
  console.log(
    `[${runId}] ${task}: ${runs} run(s) per scenario (${scenarioList.join(", ")}), ${driftRuns} drift run(s)`,
  );

  const all: Record<string, Record_[]> = {};
  for (const scenario of scenarioList) {
    all[scenario] = [];
    for (let i = 0; i < runs; i++) {
      const r = await one(scenario, ["--no-fallback"]);
      all[scenario]!.push(r);
      process.stdout.write(r.ok ? "." : "x");
    }
    process.stdout.write("\n");
  }

  const drifts: Record_[] = [];
  for (let k = 0; k < driftRuns; k++) {
    await writeFile(workflowFile, baselineText); // every drift starts from the same workflow
    const r = await one("drift", []);
    const after = await loadWorkflow();
    r.preservation = workflowPreservation(baseline, after);
    // does the recompiled workflow now handle the changed data by itself?
    const again = await one("drift-after-recompile", ["--no-fallback"]);
    await appendFile(
      outFile,
      `${JSON.stringify({ runId, kind: "preservation", drift: k + 1, ...r.preservation, afterRecompileOk: again.ok })}\n`,
    );
    drifts.push(r);
    (all["drift-after-recompile"] ??= []).push(again);
    console.log(
      `drift ${k + 1}: fallback ${r.fallback}, recompiled ${r.recompiled}, ` +
        `side effects kept ${r.preservation.sideEffects}, guards kept ${r.preservation.guards}, ` +
        `replay after recompile ${again.ok ? "ok" : "failed"}`,
    );
  }
  await writeFile(workflowFile, baselineText);

  const header = [
    "scenario",
    "runs",
    "ran",
    "mentions ok",
    "correct",
    "0 model calls",
    "wall p50 / p95",
    "engine p50 / p95",
    "tokens in / out (mean)",
    "cost (mean)",
  ];
  const rows = Object.entries(all).map(([name, rs]) => summarize(name, rs));
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(`\nrun ${runId}: ${task}`);
  console.log(
    `models: agent ${process.env.HOTPATH_AGENT_MODEL}, replay ${process.env.HOTPATH_CHEAP_MODEL}`,
  );
  console.log([line(header), ...rows.map(line)].join("\n"));
  if (driftRuns > 0) {
    const rec = drifts.filter((d) => d.fallback && d.recompiled).length;
    const kept = drifts.filter(
      (d) => d.preservation?.sideEffects && d.preservation.guards,
    ).length;
    const agentCost = drifts.map((d) => d.agent?.costUsd ?? 0);
    console.log(
      `\ndrift: ${drifts.length} run(s), recovered and recompiled ${rec}, ` +
        `side effects and guards kept ${kept}, agent cost per recovery ${usd(mean(agentCost))}`,
    );
  }
  const bad = Object.values(all)
    .flat()
    .filter(
      (r) =>
        !r.ok ||
        r.mentionsMissing.length > 0 ||
        (r.correctnessProblems !== "not defined" &&
          r.correctnessProblems.length > 0),
    );
  for (const r of bad.slice(0, 8)) {
    console.log(
      `  #${r.seq} ${r.scenario}: ${r.ok ? "" : `did not finish (${r.driftReason ?? "?"}) `}` +
        `${r.mentionsMissing.length ? `missing mentions ${r.mentionsMissing.join("; ")} ` : ""}` +
        `${Array.isArray(r.correctnessProblems) && r.correctnessProblems.length ? `wrong: ${r.correctnessProblems.join("; ")}` : ""}`,
    );
  }
  console.log(`records: out/measure-${runId}.jsonl`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
