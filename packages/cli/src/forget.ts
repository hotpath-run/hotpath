import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  loadSchedules,
  saveSchedules,
  statePaths,
} from "@hotpathrun/scheduler";
import { assertTaskName } from "@hotpathrun/shared";

// `hotpath forget <task>`: delete everything Hotpath keeps about one task.
// Traces, workflows and saved answers hold the tools' real data (emails,
// documents), so a customer must be able to remove them in one step.

export interface ForgetDirs {
  tracesDir: string;
  workflowsDir: string;
  /** .hotpath: saved answers, schedules, run history */
  stateDir: string;
  /** out/: the last run's metrics */
  outDir: string;
}

export interface ForgetItem {
  /** what it is, in words */
  what: string;
  path: string;
  kind: "folder" | "file" | "entries";
  /** files in a folder, or schedules / history lines for "entries" */
  count: number;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function runLines(
  stateDir: string,
): Promise<{ file: string; lines: string[] }> {
  const file = statePaths(stateDir).runs;
  try {
    return { file, lines: (await readFile(file, "utf8")).split("\n") };
  } catch {
    return { file, lines: [] };
  }
}

function isRunOf(line: string, task: string): boolean {
  try {
    return (JSON.parse(line) as { task?: unknown }).task === task;
  } catch {
    return false; // a torn line belongs to no task: keep it
  }
}

/** What `forget` would delete for this task. Reads only. */
export async function planForget(
  task: string,
  dirs: ForgetDirs,
): Promise<ForgetItem[]> {
  assertTaskName(task);
  const items: ForgetItem[] = [];

  const traces = path.join(dirs.tracesDir, task);
  if (await exists(traces)) {
    items.push({
      what: "recordings (tool calls and their results)",
      path: traces,
      kind: "folder",
      count: (await readdir(traces)).length,
    });
  }

  let workflowFiles: string[] = [];
  try {
    workflowFiles = await readdir(dirs.workflowsDir);
  } catch {
    workflowFiles = [];
  }
  for (const name of workflowFiles.sort()) {
    const isWorkflow = name === `${task}.json`;
    // backups written after a fallback: <task>.<timestamp>.bak.json
    const isBackup =
      name.startsWith(`${task}.`) &&
      name.endsWith(".bak.json") &&
      /^\d{4}-\d{2}-\d{2}T/.test(name.slice(task.length + 1));
    if (!isWorkflow && !isBackup) continue;
    items.push({
      what: isWorkflow ? "workflow" : "workflow backup",
      path: path.join(dirs.workflowsDir, name),
      kind: "file",
      count: 1,
    });
  }

  const answers = path.join(dirs.stateDir, "answers", `${task}.json`);
  if (await exists(answers)) {
    items.push({
      what: "saved AI answers",
      path: answers,
      kind: "file",
      count: 1,
    });
  }

  // the crash journal holds what an interrupted run's actions returned
  const journal = path.join(dirs.stateDir, "journal", task);
  if (await exists(journal)) {
    items.push({
      what: "crash journal (actions of an interrupted run)",
      path: journal,
      kind: "folder",
      count: 1,
    });
  }

  const schedules = (await loadSchedules(dirs.stateDir)).filter(
    (s) => s.task === task,
  );
  if (schedules.length > 0) {
    items.push({
      what: `schedule${schedules.length === 1 ? "" : "s"} (${schedules.map((s) => s.id).join(", ")})`,
      path: statePaths(dirs.stateDir).schedules,
      kind: "entries",
      count: schedules.length,
    });
  }

  const runs = await runLines(dirs.stateDir);
  const mine = runs.lines.filter((l) => isRunOf(l, task)).length;
  if (mine > 0) {
    items.push({
      what: "run history lines",
      path: runs.file,
      kind: "entries",
      count: mine,
    });
  }

  // The last run's metrics hold the tool arguments it sent (the AI text
  // included) and do not name their task: when in doubt, it goes too.
  const lastRun = path.join(dirs.outDir, "hotpath-run.json");
  if (items.length > 0 && (await exists(lastRun))) {
    items.push({
      what: "last run's metrics (may be another task's; it is rewritten on the next run)",
      path: lastRun,
      kind: "file",
      count: 1,
    });
  }
  return items;
}

/** The plan as lines for the terminal. */
export function describeForget(task: string, items: ForgetItem[]): string {
  if (items.length === 0) {
    return `nothing stored for task "${task}"`;
  }
  const lines = [`This deletes everything Hotpath keeps for "${task}":`];
  for (const item of items) {
    const count =
      item.kind === "folder"
        ? ` (${item.count} file${item.count === 1 ? "" : "s"})`
        : item.kind === "entries"
          ? ` (${item.count})`
          : "";
    lines.push(`  - ${item.what}${count}: ${item.path}`);
  }
  lines.push(
    "It cannot be undone. An agent that was wrapped for this task keeps " +
      "recording until you run: hotpath unwrap <agent> <server>",
  );
  return lines.join("\n");
}

/** Deletes what planForget listed. Returns the items removed. */
export async function forgetTask(
  task: string,
  dirs: ForgetDirs,
): Promise<ForgetItem[]> {
  const items = await planForget(task, dirs);
  for (const item of items) {
    if (item.kind !== "entries") {
      await rm(item.path, { recursive: item.kind === "folder", force: true });
    }
  }
  const schedules = await loadSchedules(dirs.stateDir);
  if (schedules.some((s) => s.task === task)) {
    await saveSchedules(
      dirs.stateDir,
      schedules.filter((s) => s.task !== task),
    );
  }
  const runs = await runLines(dirs.stateDir);
  if (runs.lines.some((l) => isRunOf(l, task))) {
    await writeFile(
      runs.file,
      runs.lines.filter((l) => !isRunOf(l, task)).join("\n"),
    );
  }
  return items;
}
