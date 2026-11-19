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
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// tests never call a model: a learned workflow replays from the recording
vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return {
    ...actual,
    chat: vi.fn(() => {
      throw new Error("no model call expected in learn tests");
    }),
  };
});

import type { TraceFile, Workflow } from "@hotpathrun/shared";

import {
  compileCandidate,
  groupRuns,
  learn,
  promote,
  runHealth,
  shadowCheck,
  type LearnDirs,
} from "../src/index.js";

import { unlabelledRun } from "./helpers.js";

const dates = ["2026-10-01", "2026-10-02", "2026-10-05"];
const qwenRuns = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "qwen-morning-brief",
);
const runs = () => dates.map((d) => unlabelledRun("morning-brief", d));

function failedRun(date: string): TraceFile {
  const run = unlabelledRun("morning-brief", date);
  return {
    ...run,
    calls: run.calls.map((c) =>
      c.tool === "get_calendar" ? { ...c, isError: true } : c,
    ),
  };
}

/** The calendar answered with an error the agent wrote its brief on. */
function badRecordingRun(date: string): TraceFile {
  const run = unlabelledRun("morning-brief", date);
  return {
    ...run,
    calls: run.calls.map((c) =>
      c.tool === "get_calendar"
        ? { ...c, result: { error: "calendar service unavailable" } }
        : c,
    ),
  };
}

/** The workflow with its send_message going to someone else. */
function retarget(workflow: Workflow, to: string): Workflow {
  return {
    ...workflow,
    steps: workflow.steps.map((s) =>
      s.type === "tool" && s.tool === "send_message"
        ? { ...s, args: { ...s.args, to } }
        : s,
    ),
  };
}

describe("runHealth and hot paths", () => {
  it("3 clean runs of one path make it hot", () => {
    const [group] = groupRuns(runs(), { hotAfter: 3 });
    expect(group!.runs).toHaveLength(3);
    expect(group!.hot).toBe(true);
  });

  it("a run with a failed call is not clean, and its path is not hot", () => {
    expect(runHealth(failedRun("2026-10-03")).clean).toBe(false);
    const all = [...runs().slice(0, 2), failedRun("2026-10-03")];
    const groups = groupRuns(all, { hotAfter: 3 });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hot).toBe(false);
  });

  it("a run that fails the recording check keeps its path from being hot", () => {
    const health = runHealth(badRecordingRun("2026-10-03"));
    expect(health.clean).toBe(false);
    expect(health.problems.join(" ")).toMatch(/calendar service unavailable/);
    const all = [...runs().slice(0, 2), badRecordingRun("2026-10-03")];
    const groups = groupRuns(all, { hotAfter: 3 });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hot).toBe(false);
  });

  it("an old failed run stops counting once the last N runs are clean", () => {
    const all = [failedRun("2026-09-30"), ...runs()];
    const [group] = groupRuns(all, { hotAfter: 3 });
    expect(group!.hot).toBe(true);
  });

  it("a run that is still open is not clean", () => {
    expect(runHealth({ ...runs()[0]!, open: true }).clean).toBe(false);
  });

  it("hotAfter is configurable", () => {
    expect(groupRuns(runs(), { hotAfter: 4 })[0]!.hot).toBe(false);
    expect(groupRuns(runs().slice(0, 2), { hotAfter: 2 })[0]!.hot).toBe(true);
  });

  it("counts the runs a live workflow could have served", () => {
    const more = [...runs(), unlabelledRun("morning-brief", "2026-10-06")];
    const [group] = groupRuns(more, { hotAfter: 3 });
    expect(group!.servable).toBe(1);
  });
});

describe("candidates and the shadow check", () => {
  it("compiles a candidate with the inferred inputs, and its shadow replay passes", async () => {
    const [group] = groupRuns(runs(), { hotAfter: 3 });
    const candidate = compileCandidate(group!);
    expect(candidate.workflow.task).toBe(group!.id);
    expect(Object.keys(candidate.workflow.inputs)).toEqual(["date"]);
    const shadow = await shadowCheck(candidate.workflow, group!.runs.at(-1)!);
    expect(shadow.problems).toEqual([]);
    expect(shadow.ok).toBe(true);
    expect(shadow.sideEffects).toEqual([
      expect.objectContaining({ tool: "send_message" }),
    ]);
  });

  it("fails when the replay makes a different side-effect call", async () => {
    const [group] = groupRuns(runs(), { hotAfter: 3 });
    const { workflow } = compileCandidate(group!);
    const shadow = await shadowCheck(
      retarget(workflow, "boss"),
      group!.runs.at(-1)!,
    );
    expect(shadow.ok).toBe(false);
    expect(shadow.problems.join(" ")).toMatch(/send_message/);
  });
});

describe("learn and promote (files)", () => {
  let dir: string;
  let dirs: LearnDirs;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "hotpath-learn-"));
    dirs = {
      tracesDir: path.join(dir, "traces"),
      stateDir: path.join(dir, ".hotpath"),
      workflowsDir: path.join(dir, "workflows"),
    };
    // runs under whatever folder the recorder used: learn ignores the label
    for (const [i, run] of runs().entries()) {
      const folder = path.join(dirs.tracesDir, i === 0 ? "a" : "unlabelled");
      await mkdir(folder, { recursive: true });
      await writeFile(
        path.join(folder, `run-${i}.jsonl`),
        [run.meta, ...run.calls, run.end]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
      );
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds one hot path, holds a candidate and promotes it only by hand", async () => {
    const report = await learn(dirs, { hotAfter: 3 });
    expect(report.paths).toHaveLength(1);
    const [p] = report.paths;
    expect(p!.hot).toBe(true);
    expect(p!.candidate?.shadow.ok).toBe(true);
    expect(p!.live).toBe(false);
    expect(report.promoted).toEqual([]);
    expect(await listDir(dirs.workflowsDir)).toEqual([]);

    const promoted = await promote(dirs, p!.id);
    expect(promoted.ok).toBe(true);
    const saved = JSON.parse(
      await readFile(path.join(dirs.workflowsDir, `${p!.id}.json`), "utf8"),
    ) as Workflow;
    expect(saved.task).toBe(p!.id);
    expect((await learn(dirs, { hotAfter: 3 })).paths[0]!.live).toBe(true);
  });

  it("--auto promotes a hot path whose shadow check passes", async () => {
    const report = await learn(dirs, { hotAfter: 3, auto: true });
    expect(report.paths[0]!.live).toBe(true);
    expect(report.promoted).toEqual([report.paths[0]!.id]);
  });

  it("never promotes a candidate whose shadow replay sends something else", async () => {
    const report = await learn(dirs, { hotAfter: 3 });
    const id = report.paths[0]!.id;
    // tamper with the held candidate: it now sends to someone else
    const file = path.join(dirs.stateDir, "learn", "candidates", `${id}.json`);
    const held = JSON.parse(await readFile(file, "utf8")) as {
      workflow: Workflow;
    };
    held.workflow = retarget(held.workflow, "boss");
    await writeFile(file, JSON.stringify(held));
    const promoted = await promote(dirs, id);
    expect(promoted.ok).toBe(false);
    expect(promoted.problems.join(" ")).toMatch(/send_message/);
    expect(await listDir(dirs.workflowsDir)).toEqual([]);
  });

  it("falls back to the newest run when the runs' texts disagree (3 real qwen3:1.7b runs)", async () => {
    await rm(dirs.tracesDir, { recursive: true, force: true });
    await mkdir(path.join(dirs.tracesDir, "morning-brief"), {
      recursive: true,
    });
    for (const f of await readdir(qwenRuns)) {
      await writeFile(
        path.join(dirs.tracesDir, "morning-brief", f),
        await readFile(path.join(qwenRuns, f)),
      );
    }
    const report = await learn(dirs, { hotAfter: 3, auto: true });
    expect(report.paths).toHaveLength(1);
    const c = report.paths[0]!.candidate!;
    expect(c.shadow.problems).toEqual([]);
    expect(c.fromRuns).toBe(1);
    expect(Object.keys(c.workflow.inputs)).toEqual(["date"]);
    // the newest text covers only part of the emails: a warning, so --auto
    // leaves it for a person to promote
    expect(c.warnings.length).toBeGreaterThan(0);
    expect(report.promoted).toEqual([]);
    expect((await promote(dirs, report.paths[0]!.id)).ok).toBe(true);
  });

  it("says what to do for a path that is unknown", async () => {
    await expect(promote(dirs, "path-00000000")).rejects.toThrow(
      /hotpath learn/,
    );
  });
});

async function listDir(d: string): Promise<string[]> {
  try {
    return await readdir(d);
  } catch {
    return [];
  }
}
