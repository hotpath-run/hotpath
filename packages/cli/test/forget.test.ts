// `hotpath forget <task>` removes one task's data and nothing else.
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskNameError } from "@hotpathrun/shared";

import {
  describeForget,
  forgetTask,
  planForget,
  type ForgetDirs,
} from "../src/forget.js";

let root: string;
let dirs: ForgetDirs;

const run = (task: string) =>
  JSON.stringify({
    scheduleId: null,
    task,
    startedAt: "2026-11-15T07:00:00.000Z",
    durationMs: 10,
    status: "ok",
    llmCalls: 1,
    costUsd: 0,
    fallback: false,
    sideEffectsMode: "dry-run",
  });

const schedule = (id: string, task: string) => ({
  id,
  task,
  cron: "0 7 * * *",
  timezone: "UTC",
  inputs: {},
  enabled: true,
  sideEffects: "dry-run",
  fallback: "notify",
  createdAt: "2026-11-15T00:00:00.000Z",
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hotpath-forget-"));
  dirs = {
    tracesDir: path.join(root, "traces"),
    workflowsDir: path.join(root, "workflows"),
    stateDir: path.join(root, ".hotpath"),
    outDir: path.join(root, "out"),
  };
  for (const task of ["brief", "brief-2"]) {
    await mkdir(path.join(dirs.tracesDir, task), { recursive: true });
    await writeFile(path.join(dirs.tracesDir, task, "a.jsonl"), "secret mail");
  }
  await mkdir(dirs.workflowsDir, { recursive: true });
  for (const name of [
    "brief.json",
    "brief.2026-11-15T07-00-00-000Z.bak.json",
    "brief-2.json",
    // another task whose name starts the same way, with a dot
    "brief.eu.json",
  ]) {
    await writeFile(path.join(dirs.workflowsDir, name), "{}");
  }
  await mkdir(path.join(dirs.stateDir, "answers"), { recursive: true });
  await writeFile(path.join(dirs.stateDir, "answers", "brief.json"), "{}");
  await writeFile(path.join(dirs.stateDir, "answers", "brief-2.json"), "{}");
  await writeFile(
    path.join(dirs.stateDir, "schedules.json"),
    JSON.stringify({
      version: 1,
      schedules: [
        schedule("brief-ab12", "brief"),
        schedule("b2-cd34", "brief-2"),
      ],
    }),
  );
  await writeFile(
    path.join(dirs.stateDir, "runs.jsonl"),
    [run("brief"), run("brief-2"), run("brief"), ""].join("\n"),
  );
  await mkdir(dirs.outDir, { recursive: true });
  await writeFile(path.join(dirs.outDir, "hotpath-run.json"), "{}");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("hotpath forget", () => {
  it("lists what it would delete without deleting", async () => {
    const items = await planForget("brief", dirs);
    expect(items.map((i) => i.what)).toEqual([
      "recordings (tool calls and their results)",
      "workflow backup",
      "workflow",
      "saved AI answers",
      "schedule (brief-ab12)",
      "run history lines",
      expect.stringContaining("last run's metrics"),
    ]);
    const text = describeForget("brief", items);
    expect(text).toContain("cannot be undone");
    expect(text).toContain("hotpath unwrap");
    expect(await readdir(path.join(dirs.tracesDir, "brief"))).toEqual([
      "a.jsonl",
    ]);
  });

  it("deletes the task's data and leaves every other task alone", async () => {
    await forgetTask("brief", dirs);
    expect(await readdir(dirs.tracesDir)).toEqual(["brief-2"]);
    expect((await readdir(dirs.workflowsDir)).sort()).toEqual([
      "brief-2.json",
      "brief.eu.json",
    ]);
    expect(await readdir(path.join(dirs.stateDir, "answers"))).toEqual([
      "brief-2.json",
    ]);
    const schedules = JSON.parse(
      await readFile(path.join(dirs.stateDir, "schedules.json"), "utf8"),
    ) as { schedules: Array<{ task: string }> };
    expect(schedules.schedules.map((s) => s.task)).toEqual(["brief-2"]);
    const runs = await readFile(path.join(dirs.stateDir, "runs.jsonl"), "utf8");
    expect(runs).not.toContain('"task":"brief"');
    expect(runs).toContain('"task":"brief-2"');
    expect(await readdir(dirs.outDir)).toEqual([]);
    // a second time there is nothing left
    expect(await planForget("brief", dirs)).toEqual([]);
    expect(describeForget("brief", [])).toBe('nothing stored for task "brief"');
  });

  it("refuses a task name that is a path", async () => {
    await expect(planForget("../workflows", dirs)).rejects.toThrow(
      TaskNameError,
    );
    await expect(forgetTask("..", dirs)).rejects.toThrow(TaskNameError);
    expect((await readdir(root)).sort()).toEqual([
      ".hotpath",
      "out",
      "traces",
      "workflows",
    ]);
  });
});

describe("hotpath forget: crash journal", () => {
  it("deletes the task's crash journal and keeps other tasks'", async () => {
    for (const task of ["brief", "brief-2"]) {
      await mkdir(path.join(dirs.stateDir, "journal", task), {
        recursive: true,
      });
      await writeFile(
        path.join(dirs.stateDir, "journal", task, "k.json"),
        '{"actions":{"s5":{"state":"done","result":"secret"}}}',
      );
    }
    const items = await planForget("brief", dirs);
    expect(items.map((i) => i.what)).toContain(
      "crash journal (actions of an interrupted run)",
    );
    await forgetTask("brief", dirs);
    expect(await readdir(path.join(dirs.stateDir, "journal"))).toEqual([
      "brief-2",
    ]);
  });
});
