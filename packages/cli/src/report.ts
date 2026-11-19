import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  computeStats,
  readRuns,
  type Baseline,
  type TaskStats,
} from "@hotpathrun/scheduler";
import {
  assertTaskName,
  workflowSchema,
  type CaseStep,
  type Condition,
  type RunRecord,
  type StepGuard,
  type ToolStep,
  type Workflow,
  type WorkflowStep,
} from "@hotpathrun/shared";

import type { DoctorResult } from "./setup/doctor.js";

// `hotpath report`: what a pilot user sends us when something goes wrong or to
// show results. It holds counts, timings, token counts, pass/drift flags, and
// workflow and tool names. It never holds what the tools returned or what the
// AI step wrote: every such value is replaced by its type and length.
// Nothing is uploaded; the command writes a folder the user reads first.

/** A value with its content removed: keys, types and lengths stay. */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return `<string, ${value.length} chars>`;
  if (typeof value === "number") return "<number>";
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redact(v)]),
    );
  }
  return value; // booleans and null say nothing about the data
}

const TEMPLATE_RE = /\{\{[^{}]+\}\}/g;

/** A templated value keeps its references and loses the text around them. */
function redactTemplated(value: unknown): unknown {
  if (typeof value === "string") {
    const refs = value.match(TEMPLATE_RE);
    if (!refs) return redact(value);
    return refs.length === 1 && refs[0] === value
      ? value
      : `<text, ${value.length} chars, with ${refs.join(" ")}>`;
  }
  if (Array.isArray(value)) return value.map(redactTemplated);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactTemplated(v)]),
    );
  }
  return redact(value);
}

/** JSON-schema keywords whose values describe shape, not data. */
const SCHEMA_KEYS = new Set(["type", "properties", "items", "required"]);

function schemaShape(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(schemaShape);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(key)) continue; // const, enum, default, description…
    out[key] =
      key === "properties" && value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, schemaShape(v)]),
          )
        : key === "items"
          ? schemaShape(value)
          : value;
  }
  return out;
}

function guardShape(guard: StepGuard): unknown {
  return {
    ...(guard.schema ? { schema: schemaShape(guard.schema) } : {}),
    ...(guard.nonEmpty !== undefined ? { nonEmpty: guard.nonEmpty } : {}),
    ...(guard.maxChars !== undefined ? { maxChars: guard.maxChars } : {}),
    ...(guard.grounding
      ? { mustMention: guard.grounding.flatMap((g) => g.paths) }
      : {}),
    ...(guard.exampleFacts ? { exampleFacts: guard.exampleFacts.length } : {}),
  };
}

function conditionShape(when: Condition): unknown {
  if (when.kind === "ask") {
    return { kind: "ask", reads: when.prompt.match(TEMPLATE_RE) ?? [] };
  }
  return "value" in when
    ? { kind: when.kind, ref: when.ref, value: redact(when.value) }
    : { kind: when.kind, ref: when.ref };
}

function toolShape(step: ToolStep): unknown {
  return {
    id: step.id,
    type: "tool",
    tool: step.tool,
    sideEffect: step.sideEffect,
    args: redactTemplated(step.args),
    guard: guardShape(step.guard),
    ...(step.when ? { when: conditionShape(step.when) } : {}),
  };
}

function stepShape(step: WorkflowStep | CaseStep): unknown {
  if (step.type === "tool") return toolShape(step);
  if (step.type === "branch") {
    // the rule's value (e.g. "urgent") is redacted like any recorded value
    return {
      id: step.id,
      type: "branch",
      cases: step.cases.map((c) => ({
        when: conditionShape(c.when),
        steps: c.steps.map(stepShape),
      })),
      ...(step.else ? { else: step.else.map(stepShape) } : {}),
      ...(step.when ? { when: conditionShape(step.when) } : {}),
    };
  }
  if (step.type === "foreach") {
    return {
      id: step.id,
      type: "foreach",
      over: step.over,
      as: step.as,
      maxItems: step.maxItems,
      body: step.body.map(toolShape),
      ...(step.when ? { when: conditionShape(step.when) } : {}),
    };
  }
  return {
    id: step.id,
    type: "llm",
    model: step.model,
    reads: step.prompt.match(TEMPLATE_RE) ?? [],
    promptChars: step.prompt.length,
    exampleChars: step.example.length,
    exampleLines: step.example.split("\n").length,
    guard: guardShape(step.guard),
    ...(step.when ? { when: conditionShape(step.when) } : {}),
  };
}

/** A workflow's structure: steps, tools, references, guards. No recorded value. */
export function workflowStructure(workflow: Workflow): unknown {
  const argv = workflow.serverArgv ?? workflow.server.split(/\s+/);
  return {
    task: workflow.task,
    // the command's name only: its arguments and folder can hold tokens or names
    server: {
      command: path.basename(argv[0] ?? ""),
      arguments: Math.max(0, argv.length - 1),
    },
    inputs: Object.fromEntries(
      Object.entries(workflow.inputs).map(([name, def]) => [name, def.type]),
    ),
    steps: workflow.steps.map(stepShape),
    ...(workflow.require ? { require: workflow.require } : {}),
    ...(workflow.droppedCalls
      ? {
          droppedCalls: workflow.droppedCalls.map((d) => ({
            tool: d.tool,
            reason: d.reason,
          })),
        }
      : {}),
    ...(workflow.baseline ? { baseline: workflow.baseline } : {}),
  };
}

/**
 * A drift reason quotes the data ("does not mention: Q3 budget review…"), so
 * the report keeps only what kind of problem it was.
 */
export function problemKind(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const kinds: Array<[RegExp, string]> = [
    [/grounding guard/, "text left out required values"],
    [/stale-fact guard/, "text repeated facts from the recording"],
    [/token cap/, "model stopped at the token cap"],
    [/exceeds maxChars|is empty/, "text too long or empty"],
    [/returned an error/, "a tool returned an error"],
    [/is not a list any more/, "a list is no longer a list"],
    [/could not decide/, "the model did not answer yes or no"],
    [
      /required property|must (be|have|match)|recorded schema/,
      "a tool result changed shape",
    ],
    [/missing required input/, "an input was not given"],
    [/no workflow for task/, "no workflow"],
  ];
  const kind = kinds.find(([re]) => re.test(reason))?.[1] ?? "other";
  const notes = [
    /side effect already ran/.test(reason) ? "after a side effect" : "",
    /agent not run/.test(reason) ? "agent not run" : "",
  ].filter(Boolean);
  return notes.length > 0 ? `${kind} (${notes.join(", ")})` : kind;
}

/** One trace line with every recorded value redacted (tool names stay). */
export function redactTraceLine(line: unknown): unknown {
  const l = line as Record<string, unknown>;
  if (l.type === "meta") {
    const tools = Array.isArray(l.tools) ? l.tools : [];
    return {
      type: "meta",
      version: l.version,
      task: l.task,
      inputs: redact(l.inputs),
      tools: tools.map((t) => {
        const tool = t as Record<string, unknown>;
        return {
          name: tool.name,
          inputSchema: schemaShape(tool.inputSchema),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        };
      }),
    };
  }
  if (l.type === "tool_call") {
    return {
      type: "tool_call",
      seq: l.seq,
      tool: l.tool,
      args: redact(l.args),
      result: redact(l.result),
      isError: l.isError,
      durationMs: l.durationMs,
    };
  }
  return { type: l.type, toolCalls: l.toolCalls };
}

export interface ReportDirs {
  tracesDir: string;
  workflowsDir: string;
  stateDir: string;
  outDir: string;
}

export interface ReportOptions {
  dirs: ReportDirs;
  /** only this task (default: every task found) */
  task?: string;
  /** add the recordings, redacted */
  includeTraces?: boolean;
  /** how many recent runs to list (default 20) */
  runs?: number;
  version: string;
  env: Record<string, string | undefined>;
  doctor?: DoctorResult;
  now?: Date;
  /** folders shown as ~ and <project> in the doctor lines */
  home?: string;
  project?: string;
}

/** Recent recordings per task that --include-traces adds. */
const TRACES_PER_TASK = 3;

async function names(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function providerHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host; // never the path, query or credentials
  } catch {
    return undefined;
  }
}

/** The report as files: relative name → content. Reads only. */
export async function buildReport(
  options: ReportOptions,
): Promise<Map<string, string>> {
  const { dirs, env } = options;
  if (options.task) assertTaskName(options.task);
  const now = options.now ?? new Date();
  const wanted = (task: string) => !options.task || task === options.task;

  const workflowFiles = (await names(dirs.workflowsDir)).filter(
    (f) => f.endsWith(".json") && !f.endsWith(".bak.json"),
  );
  const workflows = new Map<string, Workflow>();
  for (const file of workflowFiles) {
    const parsed = workflowSchema.safeParse(
      await readJson(path.join(dirs.workflowsDir, file)),
    );
    if (parsed.success && wanted(parsed.data.task)) {
      workflows.set(parsed.data.task, parsed.data);
    }
  }
  const allRuns = (await readRuns(dirs.stateDir)).filter((r) => wanted(r.task));
  const traceTasks = (await names(dirs.tracesDir)).filter(wanted);
  const tasks = [
    ...new Set([
      ...workflows.keys(),
      ...traceTasks,
      ...allRuns.map((r) => r.task),
    ]),
  ].sort();

  const baselines = new Map<string, Baseline>(
    tasks.map((t) => [t, workflows.get(t)?.baseline]),
  );
  const stats = new Map<string, TaskStats>(
    computeStats(allRuns, baselines).map((s) => [s.task, s]),
  );
  const recordings = new Map<string, string[]>();
  for (const task of tasks) {
    recordings.set(
      task,
      (await names(path.join(dirs.tracesDir, task))).filter((f) =>
        f.endsWith(".jsonl"),
      ),
    );
  }

  const runLine = (r: RunRecord) => ({
    task: r.task,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    status: r.status,
    llmCalls: r.llmCalls,
    costUsd: r.costUsd,
    fallback: r.fallback,
    sideEffects: r.sideEffectsMode,
    ...(r.error ? { problem: problemKind(r.error) } : {}),
  });

  // the last run of any task; kept only when no task was asked for, because
  // the file does not say which task it was
  const last = options.task
    ? null
    : ((await readJson(path.join(dirs.outDir, "hotpath-run.json"))) as Record<
        string,
        unknown
      > | null);
  const lastRun = last
    ? {
        durationMs: last.durationMs,
        connectMs: last.connectMs,
        toolMs: last.toolMs,
        llmMs: last.llmMs,
        rateLimitWaitMs: last.rateLimitWaitMs,
        llmCalls: last.llmCalls,
        promptTokens: last.promptTokens,
        completionTokens: last.completionTokens,
        costUsd: last.costUsd,
        fallback: last.fallback,
        recompiled: last.recompiled,
        driftStep: last.driftStep,
        problem: problemKind(
          typeof last.reason === "string" ? last.reason : undefined,
        ),
        steps: last.steps,
        tools: Array.isArray(last.toolCalls)
          ? last.toolCalls.map((c) => (c as { tool?: unknown }).tool)
          : undefined,
        repairedSteps: last.repairedSteps,
        reusedSteps: last.reusedSteps,
      }
    : undefined;

  const tidy = (text: string) => {
    let out = text;
    if (options.project) out = out.split(options.project).join("<project>");
    if (options.home) out = out.split(options.home).join("~");
    return out;
  };

  const report = {
    generatedAt: now.toISOString(),
    hotpath: options.version,
    node: process.versions.node,
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    models: {
      agent: env.HOTPATH_AGENT_MODEL,
      replay: env.HOTPATH_CHEAP_MODEL,
      provider: providerHost(env.LLM_BASE_URL ?? env.MOONSHOT_BASE_URL),
    },
    settings: {
      replayThinking: env.HOTPATH_CHEAP_REASONING,
      repairMentions: env.HOTPATH_REPAIR_MENTIONS,
      reuse: env.HOTPATH_REUSE,
      maxTokens: env.HOTPATH_CHEAP_MAX_TOKENS,
    },
    tasks: tasks.map((task) => ({
      task,
      recordings: recordings.get(task)?.length ?? 0,
      stats: stats.get(task) ?? null,
      workflow: workflows.has(task)
        ? workflowStructure(workflows.get(task)!)
        : null,
    })),
    recentRuns: allRuns.slice(-(options.runs ?? 20)).map(runLine),
    ...(lastRun ? { lastRun } : {}),
    ...(options.doctor
      ? {
          doctor: {
            checks: options.doctor.checks.map((c) => ({
              name: c.name,
              status: c.status,
              detail: tidy(c.detail),
            })),
            next: tidy(options.doctor.next),
          },
        }
      : {}),
  };

  const files = new Map<string, string>();
  files.set("report.json", JSON.stringify(report, null, 2) + "\n");

  if (options.includeTraces) {
    for (const task of tasks) {
      for (const name of (recordings.get(task) ?? []).slice(-TRACES_PER_TASK)) {
        const text = await readFile(
          path.join(dirs.tracesDir, task, name),
          "utf8",
        );
        const lines: string[] = [];
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            lines.push(JSON.stringify(redactTraceLine(JSON.parse(line))));
          } catch {
            // a torn line is left out rather than copied as it is
          }
        }
        files.set(`traces/${task}/${name}`, lines.join("\n") + "\n");
      }
    }
  }
  return files;
}

const MAX_TASKS_SHOWN = 8;

/** What is in the report, for the user to read before it is written. */
export function describeReport(
  files: Map<string, string>,
  dir: string,
): string {
  const report = JSON.parse(files.get("report.json")!) as {
    tasks: Array<{ task: string; recordings: number; workflow: unknown }>;
    recentRuns: unknown[];
    lastRun?: unknown;
    doctor?: unknown;
    models: { agent?: string; replay?: string; provider?: string };
  };
  const traces = [...files.keys()].filter((f) => f.startsWith("traces/"));
  const shown = report.tasks.slice(0, MAX_TASKS_SHOWN).map((t) => t.task);
  const taskList =
    shown.length === 0
      ? "(none)"
      : shown.join(", ") +
        (report.tasks.length > shown.length
          ? ` and ${report.tasks.length - shown.length} more (all are named in report.json)`
          : "");
  const lines = [
    `Report folder: ${dir}`,
    "",
    "report.json holds:",
    "  - versions: Hotpath, Node, operating system",
    `  - model names: agent ${report.models.agent ?? "(not set)"}, replay ${report.models.replay ?? "(not set)"}, provider ${report.models.provider ?? "(not set)"}`,
    `  - ${report.tasks.length} task${report.tasks.length === 1 ? "" : "s"}: ${taskList}`,
    "    for each: runs, success rate, cost, estimated savings, and the workflow's",
    "    structure (steps, tool names, which step reads which, guards)",
    `  - the last ${report.recentRuns.length} scheduled run${report.recentRuns.length === 1 ? "" : "s"}: time, status, cost, the kind of problem`,
    ...(report.lastRun
      ? ["  - the last run's step timings and token counts"]
      : []),
    ...(report.doctor ? ["  - what `hotpath doctor` shows"] : []),
    "",
    "Left out: what your tools returned, what the AI step wrote, tool arguments,",
    "drift messages (they quote data), the server's command line, and your key.",
    "Every such value is replaced by its type and length, e.g. <string, 42 chars>.",
  ];
  if (traces.length > 0) {
    lines.push(
      "",
      `--include-traces: ${traces.length} recording${traces.length === 1 ? "" : "s"} with every text and number replaced the same way.`,
      "Tool names, field names and how many items each list had stay visible.",
      "Field names can themselves be data (a table keyed by email address): look before sending.",
    );
  }
  lines.push(
    "",
    "Nothing is sent anywhere. Read the files, then send the folder yourself.",
  );
  return lines.join("\n");
}

/** Writes the files under `dir` (created if needed). */
export async function writeReport(
  dir: string,
  files: Map<string, string>,
): Promise<void> {
  for (const [name, content] of files) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}
