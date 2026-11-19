// task 08: `hotpath report` is what a pilot user sends us. It must not
// carry their data: no value a tool returned, no text the AI step wrote, no
// tool argument, no key.
import {
  copyFile,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileTrace } from "@hotpathrun/compiler";
import { readTrace, TaskNameError, type TraceFile } from "@hotpathrun/shared";

import {
  buildReport,
  describeReport,
  problemKind,
  redact,
  workflowStructure,
  writeReport,
  type ReportOptions,
} from "../src/report.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../compiler/test/fixtures/morning-brief.jsonl",
);
const FAKE_KEY = ["sk", "test", "0123456789abcdef"].join("-");

let root: string;
let options: ReportOptions;
let trace: TraceFile;

/** Every text of 4+ characters inside a value (shorter ones match by accident). */
function texts(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (value.trim().length >= 4) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) texts(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) texts(v, out);
  }
  return out;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hotpath-report-"));
  const dirs = {
    tracesDir: path.join(root, "traces"),
    workflowsDir: path.join(root, "workflows"),
    stateDir: path.join(root, ".hotpath"),
    outDir: path.join(root, "out"),
  };
  trace = await readTrace(fixture);
  await mkdir(path.join(dirs.tracesDir, "morning-brief"), { recursive: true });
  await copyFile(
    fixture,
    path.join(dirs.tracesDir, "morning-brief", "rec-a.jsonl"),
  );
  const workflow = compileTrace(trace, "traces/morning-brief/rec-a.jsonl");
  await mkdir(dirs.workflowsDir, { recursive: true });
  await writeFile(
    path.join(dirs.workflowsDir, "morning-brief.json"),
    JSON.stringify(workflow),
  );
  await mkdir(dirs.stateDir, { recursive: true });
  const run = (status: string, error?: string) =>
    JSON.stringify({
      scheduleId: null,
      task: "morning-brief",
      startedAt: "2026-11-14T07:00:00.000Z",
      durationMs: 900,
      status,
      llmCalls: 1,
      costUsd: 0.002,
      fallback: false,
      sideEffectsMode: "dry-run",
      ...(error ? { error } : {}),
    });
  await writeFile(
    path.join(dirs.stateDir, "runs.jsonl"),
    [
      run("ok"),
      run(
        "drift",
        "drift at s4: llm output does not mention: Team offsite: draft agenda attached (grounding guard)",
      ),
      "",
    ].join("\n"),
  );
  await mkdir(dirs.outDir, { recursive: true });
  await writeFile(
    path.join(dirs.outDir, "hotpath-run.json"),
    JSON.stringify({
      durationMs: 900,
      llmCalls: 1,
      promptTokens: 400,
      completionTokens: 90,
      costUsd: 0.002,
      fallback: false,
      steps: [{ id: "s1", durationMs: 12, ok: true }],
      connectMs: 220,
      toolMs: 30,
      llmMs: 600,
      rateLimitWaitMs: 0,
      toolCalls: [
        { tool: "get_emails", args: { date: "2026-10-01" } },
        {
          tool: "send_message",
          args: { to: "me", text: "Dentist appointment at 14:00" },
        },
      ],
      driftStep: "s4",
      reason:
        "llm output repeats facts that are not in this run's data: Metro line 4 closed this weekend (stale-fact guard)",
    }),
  );
  await writeFile(path.join(root, ".env"), `LLM_API_KEY=${FAKE_KEY}\n`);
  options = {
    dirs,
    version: "0.1.0",
    env: {
      LLM_API_KEY: FAKE_KEY,
      LLM_BASE_URL: `https://user:${FAKE_KEY}@api.example.com/v1?key=${FAKE_KEY}`,
      HOTPATH_AGENT_MODEL: "big-model",
      HOTPATH_CHEAP_MODEL: "small-model",
      HOTPATH_REPAIR_MENTIONS: "1",
    },
    doctor: {
      checks: [
        {
          name: "Settings",
          status: "ok",
          detail: `${path.join(root, ".env")} · key set (not shown)`,
        },
      ],
      next: "hotpath run morning-brief --dry-run",
    },
    now: new Date("2026-11-15T10:00:00.000Z"),
    project: root,
    home: os.homedir(),
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("redaction", () => {
  it("keeps keys, types and lengths; drops every text and number", () => {
    expect(
      redact({ a: "hello", n: 42, ok: true, none: null, list: ["x", 1] }),
    ).toEqual({
      a: "<string, 5 chars>",
      n: "<number>",
      ok: true,
      none: null,
      list: ["<string, 1 chars>", "<number>"],
    });
  });

  it("a drift reason becomes the kind of problem, without the quoted data", () => {
    expect(
      problemKind(
        "llm output does not mention: Q3 budget review (grounding guard)",
      ),
    ).toBe("text left out required values");
    expect(
      problemKind(
        "result/emails/0 must have required property 'subject' — a side effect already ran, so the agent was not run",
      ),
    ).toBe("a tool result changed shape (after a side effect)");
    expect(problemKind("something new")).toBe("other");
    expect(problemKind(undefined)).toBeUndefined();
  });

  it("a workflow keeps its structure: tools, references, guards", () => {
    const structure = workflowStructure(compileTrace(trace, "x")) as {
      steps: Array<Record<string, unknown>>;
      inputs: unknown;
    };
    expect(structure.inputs).toEqual({ date: "string" });
    expect(structure.steps.map((s) => s.tool ?? s.type)).toEqual([
      "get_emails",
      "get_calendar",
      "get_weather",
      "llm",
      "send_message",
    ]);
    expect(structure.steps[2]!.args).toEqual({
      city: "<string, 5 chars>",
      date: "{{inputs.date}}",
    });
    expect(structure.steps[4]!.args).toEqual({
      to: "<string, 2 chars>",
      text: "{{steps.s4.output}}",
    });
    const llm = structure.steps[3]!;
    expect(llm.reads).toEqual([
      "{{steps.s1.result}}",
      "{{steps.s2.result}}",
      "{{steps.s3.result}}",
    ]);
    expect((llm.guard as { mustMention: string[] }).mustMention).toContain(
      "steps.s1.result.emails.*.subject",
    );
  });
});

describe("hotpath report", () => {
  it("holds versions, models, stats, runs and structure", async () => {
    const files = await buildReport(options);
    expect([...files.keys()]).toEqual(["report.json"]);
    const report = JSON.parse(files.get("report.json")!);
    expect(report.hotpath).toBe("0.1.0");
    expect(report.models).toEqual({
      agent: "big-model",
      replay: "small-model",
      provider: "api.example.com",
    });
    expect(report.tasks).toHaveLength(1);
    expect(report.tasks[0].task).toBe("morning-brief");
    expect(report.tasks[0].recordings).toBe(1);
    expect(report.tasks[0].stats).toMatchObject({ runs: 2, ok: 1 });
    expect(report.recentRuns.map((r: { status: string }) => r.status)).toEqual([
      "ok",
      "drift",
    ]);
    expect(report.recentRuns[1].problem).toBe("text left out required values");
    expect(report.lastRun.problem).toBe(
      "text repeated facts from the recording",
    );
    expect(report.lastRun.tools).toEqual(["get_emails", "send_message"]);
    expect(report.lastRun.promptTokens).toBe(400);
    expect(report.doctor.checks[0].detail).toBe(
      `${path.join("<project>", ".env")} · key set (not shown)`,
    );
  });

  it("holds no value from the recording or the workflow, and no key", async () => {
    const files = await buildReport(options);
    const text = [...files.values()].join("\n");
    const workflow = compileTrace(trace, "x");
    const secrets = new Set([
      ...texts(trace.calls.map((c) => [c.args, c.result])),
      ...texts(trace.meta.inputs),
      ...texts(
        workflow.steps.map((s) =>
          s.type === "llm" ? [s.example, s.guard.exampleFacts] : [],
        ),
      ),
    ]);
    // sanity: the list really holds the recording's data
    expect(secrets).toContain("Q3 budget review moved to 14:00");
    expect(secrets).toContain("alice@corp.com");
    expect(secrets).toContain("2026-10-01");
    expect(secrets.size).toBeGreaterThan(15);
    for (const secret of secrets) {
      expect(text.includes(secret), `leaked: ${secret}`).toBe(false);
    }
    // from the runs and the last run's metrics
    for (const secret of [
      "Team offsite",
      "Metro line 4",
      "Dentist appointment",
      FAKE_KEY,
      "user:",
    ]) {
      expect(text.includes(secret), `leaked: ${secret}`).toBe(false);
    }
  });

  it("--include-traces adds the recordings with structure only", async () => {
    const files = await buildReport({ ...options, includeTraces: true });
    expect([...files.keys()]).toEqual([
      "report.json",
      "traces/morning-brief/rec-a.jsonl",
    ]);
    const text = files.get("traces/morning-brief/rec-a.jsonl")!;
    for (const secret of texts(trace.calls.map((c) => [c.args, c.result]))) {
      expect(text.includes(secret), `leaked: ${secret}`).toBe(false);
    }
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual([
      "meta",
      "tool_call",
      "tool_call",
      "tool_call",
      "tool_call",
      "end",
    ]);
    expect(lines[0].tools.map((t: { name: string }) => t.name)).toContain(
      "send_message",
    );
    expect(lines[0].inputs).toEqual({ date: "<string, 10 chars>" });
    expect(lines[1].tool).toBe("get_emails");
    expect(lines[1].args).toEqual({ date: "<string, 10 chars>" });
    expect(lines[1].result.emails).toHaveLength(3);
    expect(lines[1].result.emails[0]).toEqual({
      id: "<string, 2 chars>",
      from: "<string, 14 chars>",
      subject: "<string, 31 chars>",
      snippet: "<string, 59 chars>",
    });
    expect(lines[3].result.highC).toBe("<number>");
    // and the description says so
    expect(describeReport(files, "x")).toContain(
      "--include-traces: 1 recording",
    );
  });

  it("--task limits it to one task, and refuses a path", async () => {
    const other = await buildReport({ ...options, task: "weekly" });
    expect(JSON.parse(other.get("report.json")!).tasks).toEqual([]);
    expect(JSON.parse(other.get("report.json")!).lastRun).toBeUndefined();
    await expect(buildReport({ ...options, task: "../x" })).rejects.toThrow(
      TaskNameError,
    );
  });

  it("says what is in it before writing, then writes plain files", async () => {
    const files = await buildReport(options);
    const dir = path.join(root, "hotpath-report-2026-11-15");
    const description = describeReport(files, dir);
    expect(description).toContain("1 task: morning-brief");
    expect(description).toContain("Left out: what your tools returned");
    expect(description).toContain("Nothing is sent anywhere");
    expect(description).not.toContain(FAKE_KEY);

    await writeReport(dir, files);
    expect(await readdir(dir)).toEqual(["report.json"]);
    expect(await readFile(path.join(dir, "report.json"), "utf8")).toBe(
      files.get("report.json"),
    );
  });
});
