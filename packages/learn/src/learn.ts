// The file side of hotpath learn: read every recorded run, group, compile the
// hot paths into candidates held under .hotpath/learn/, and make a candidate
// live (workflows/<path>.json) only when its shadow check passes.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { agentBaseline } from "@hotpathrun/compiler";
import {
  assertTaskName,
  readTrace,
  workflowSchema,
  type TraceFile,
  type Workflow,
} from "@hotpathrun/shared";

import {
  compileCandidate,
  shadowCheck,
  type ShadowResult,
} from "./candidate.js";
import { DEFAULT_HOT_AFTER, groupRuns, type PathGroup } from "./paths.js";

export interface LearnDirs {
  tracesDir: string;
  stateDir: string;
  workflowsDir: string;
  /** where the demo agent writes its cost (out/agent-run.json); optional */
  agentRunFile?: string;
}

export interface LearnOptions {
  hotAfter?: number;
  /** promote every hot path whose shadow check passes */
  auto?: boolean;
}

export interface HeldCandidate {
  workflow: Workflow;
  warnings: string[];
  inputs: Record<string, unknown>;
  /** how many runs the workflow was compiled from */
  fromRuns: number;
  shadow: ShadowResult;
  /** the run the shadow check replays: the path's newest clean run */
  runFile: string;
  compiledAt: string;
}

export interface PathReport {
  id: string;
  steps: string[];
  runs: number;
  cleanRuns: number;
  hot: boolean;
  /** why the last runs are not clean, newest first */
  problems: string[];
  servable: number;
  /** agent cost of the runs, where the agent reported one */
  costUsd: number;
  costKnownRuns: number;
  candidate?: HeldCandidate;
  live: boolean;
}

export interface LearnReport {
  hotAfter: number;
  paths: PathReport[];
  promoted: string[];
  /** traces that could not be read (a half-written file, another format) */
  skipped: string[];
}

interface Run {
  file: string;
  trace: TraceFile;
}

/** Every finished trace under traces/<any folder>/, oldest first. */
export async function readRuns(
  tracesDir: string,
): Promise<{ runs: Run[]; skipped: string[] }> {
  const runs: Run[] = [];
  const skipped: string[] = [];
  let folders: string[];
  try {
    folders = await readdir(tracesDir);
  } catch {
    return { runs, skipped };
  }
  for (const folder of folders.sort()) {
    let files: string[];
    try {
      files = (await readdir(path.join(tracesDir, folder))).filter((f) =>
        f.endsWith(".jsonl"),
      );
    } catch {
      continue; // a file, not a folder
    }
    for (const f of files) {
      const file = path.join(tracesDir, folder, f);
      try {
        // an open trace counts as a run that did not finish (not clean)
        runs.push({ file, trace: await readTrace(file, { allowOpen: true }) });
      } catch {
        skipped.push(file);
      }
    }
  }
  runs.sort(
    (a, b) =>
      a.trace.meta.startedAt.localeCompare(b.trace.meta.startedAt) ||
      a.file.localeCompare(b.file),
  );
  return { runs, skipped };
}

/** `learn.hotAfter` from hotpath.config.json; the default when unset or unreadable. */
export async function configuredHotAfter(configFile: string): Promise<number> {
  try {
    const config = JSON.parse(await readFile(configFile, "utf8")) as {
      learn?: { hotAfter?: unknown };
    };
    const n = config.learn?.hotAfter;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1) return n;
  } catch {
    // no config: the default
  }
  return DEFAULT_HOT_AFTER;
}

const candidatesDir = (dirs: LearnDirs) =>
  path.join(dirs.stateDir, "learn", "candidates");
const candidateFile = (dirs: LearnDirs, id: string) =>
  path.join(candidatesDir(dirs), `${assertTaskName(id)}.json`);
const workflowFile = (dirs: LearnDirs, id: string) =>
  path.join(dirs.workflowsDir, `${assertTaskName(id)}.json`);

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readCandidate(
  dirs: LearnDirs,
  id: string,
): Promise<HeldCandidate | undefined> {
  try {
    const held = JSON.parse(
      await readFile(candidateFile(dirs, id), "utf8"),
    ) as HeldCandidate;
    return { ...held, workflow: workflowSchema.parse(held.workflow) };
  } catch {
    return undefined;
  }
}

/** Group every run, compile hot paths into candidates, and (with auto) promote. */
export async function learn(
  dirs: LearnDirs,
  options: LearnOptions = {},
): Promise<LearnReport> {
  const hotAfter = options.hotAfter ?? DEFAULT_HOT_AFTER;
  const { runs, skipped } = await readRuns(dirs.tracesDir);
  const fileOf = new Map(runs.map((r) => [r.trace, r.file]));
  const groups = groupRuns(
    runs.map((r) => r.trace),
    { hotAfter },
  );
  const paths: PathReport[] = [];
  const promoted: string[] = [];
  for (const group of groups) {
    const report = await describePath(dirs, group);
    if (group.hot) {
      report.candidate = await holdCandidate(dirs, group, fileOf);
      // --auto takes no risk a person has not seen: a candidate with a
      // compile warning waits for --promote
      if (
        options.auto &&
        !report.live &&
        report.candidate.shadow.ok &&
        report.candidate.warnings.length === 0
      ) {
        await writeLive(dirs, report.candidate.workflow);
        report.live = true;
        promoted.push(group.id);
      }
    } else {
      report.candidate = await readCandidate(dirs, group.id);
    }
    paths.push(report);
  }
  return { hotAfter, paths, promoted, skipped };
}

async function describePath(
  dirs: LearnDirs,
  group: PathGroup,
): Promise<PathReport> {
  let costUsd = 0;
  let costKnownRuns = 0;
  for (const run of group.runs) {
    const baseline = await agentBaseline(
      run,
      dirs.agentRunFile ??
        path.join(dirs.stateDir, "..", "out", "agent-run.json"),
    );
    if (baseline?.costUsd !== undefined) {
      costUsd += baseline.costUsd;
      costKnownRuns++;
    }
  }
  const problems = group.health
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => !h.clean)
    .reverse()
    .slice(0, 3)
    .map(({ h, i }) => `run ${i + 1}: ${h.problems.join("; ")}`);
  return {
    id: group.id,
    steps: group.steps,
    runs: group.runs.length,
    cleanRuns: group.health.filter((h) => h.clean).length,
    hot: group.hot,
    problems,
    servable: group.servable,
    costUsd,
    costKnownRuns,
    live: await exists(workflowFile(dirs, group.id)),
  };
}

async function holdCandidate(
  dirs: LearnDirs,
  group: PathGroup,
  fileOf: Map<TraceFile, string>,
): Promise<HeldCandidate> {
  const newest = group.runs.filter((_, i) => group.health[i]!.clean).at(-1)!;
  let candidate = compileCandidate(group);
  let shadow = await shadowCheck(candidate.workflow, newest, candidate.inputs);
  if (!shadow.ok && candidate.fromRuns > 1) {
    // the runs disagree (a weak agent writes a different text each time):
    // the newest run alone may still make a workflow that does what it did
    const alone = compileCandidate(group, { newestOnly: true });
    const second = await shadowCheck(alone.workflow, newest, alone.inputs);
    if (second.ok) {
      candidate = alone;
      shadow = second;
    }
  }
  const held: HeldCandidate = {
    ...candidate,
    shadow,
    runFile: fileOf.get(newest)!,
    compiledAt: new Date().toISOString(),
  };
  await mkdir(candidatesDir(dirs), { recursive: true, mode: 0o700 });
  await writeFile(
    candidateFile(dirs, group.id),
    JSON.stringify(held, null, 2) + "\n",
  );
  return held;
}

async function writeLive(dirs: LearnDirs, workflow: Workflow): Promise<void> {
  await mkdir(dirs.workflowsDir, { recursive: true, mode: 0o700 });
  await writeFile(
    workflowFile(dirs, workflow.task),
    JSON.stringify(workflow, null, 2) + "\n",
  );
}

export interface PromoteResult {
  ok: boolean;
  problems: string[];
  workflowFile?: string;
}

/**
 * Make a held candidate live, after running its shadow check again on the
 * run it came from: a candidate edited or gone stale since is never promoted.
 */
export async function promote(
  dirs: LearnDirs,
  id: string,
): Promise<PromoteResult> {
  const held = await readCandidate(dirs, id);
  if (!held) {
    throw new Error(
      `no candidate for "${id}": run hotpath learn to list the paths, and promote one that is hot`,
    );
  }
  let run: TraceFile;
  try {
    run = await readTrace(held.runFile, { allowOpen: true });
  } catch {
    throw new Error(
      `the run that ${id} was checked on (${held.runFile}) is gone: run hotpath learn again to compile it from the runs there are`,
    );
  }
  const shadow = await shadowCheck(held.workflow, run, held.inputs);
  if (!shadow.ok) return { ok: false, problems: shadow.problems };
  await writeLive(dirs, held.workflow);
  return { ok: true, problems: [], workflowFile: workflowFile(dirs, id) };
}
