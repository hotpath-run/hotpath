import { markCalculations } from "./calculations.js";
import { writeBeforeActing } from "./order.js";
import { recordingProblems } from "./recording-check.js";
import { pruneTraces, retainDays } from "./retention.js";
import { markDerived, strongNotes } from "./derived.js";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertTaskName,
  llmStepsOf,
  toolStepsOf,
  whenText,
  projectRoot,
  readTrace,
  workflowSchema,
  type CaseStep,
  type Condition,
  type ToolStep,
  type WorkflowStep,
  type TraceFile,
  type Workflow,
} from "@hotpathrun/shared";

import { compileTraces, MAX_RECORDINGS } from "./branches.js";
import type { RecordedResult } from "./compiler.js";
import {
  applyRequirements,
  coverageWarnings,
  listCoverage,
  markSelective,
} from "./coverage.js";

// the project folder (the repository in a checkout; see projectRoot)
const repoRoot = projectRoot();

export const tracesDir = path.join(repoRoot, "traces");
export const workflowsDir = path.join(repoRoot, "workflows");

export async function latestTraceFile(task: string): Promise<string> {
  const dir = path.join(tracesDir, assertTaskName(task));
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    throw new Error(
      `no traces found for task "${task}" in ${dir} — run hotpath record first`,
    );
  }
  files.sort();
  return path.join(dir, files[files.length - 1]);
}

// Compile a trace without touching workflows/ (the runtime inspects a recompile
// before deciding whether to replace the old workflow).
export interface CompileOptions {
  /** paths to require for every item (`--require`); a path that does not fit is an error */
  require?: string[];
  /** the task only reads (`--read-only`): a recording with no action is accepted */
  readOnly?: boolean;
}

export interface CompileResult {
  workflow: Workflow;
  traceFile: string;
  warnings: string[];
  /** what the compile learned or was told beyond the newest recording */
  notes: string[];
}

export async function compileTaskInMemory(
  task: string,
  traceFile?: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const resolved = traceFile
    ? path.resolve(traceFile)
    : await latestTraceFile(task);
  // open: Claude Code and other long-lived clients keep the recorder running
  const trace = await readTrace(resolved, { allowOpen: true });
  if (trace.meta.task !== task) {
    throw new Error(
      `trace task is "${trace.meta.task}" but you asked to compile "${task}" — check --trace`,
    );
  }
  // an agent that stopped before anything worked (its model refused, it
  // crashed) leaves a recording with nothing to replay: a workflow from it
  // would do nothing and count as a successful run
  if (!trace.calls.some((c) => !c.isError)) {
    throw new Error(
      `the recording of "${task}" (${path.basename(resolved)}) has no tool call that worked: ` +
        "the agent stopped before doing the task (check its output for the error). " +
        "Nothing was compiled; fix the cause and record it again.",
    );
  }
  const saved = await previousSaved(task);
  const readOnly = options.readOnly === true || saved.readOnly;
  if (!readOnly) {
    const problem = halfDoneRecording(trace);
    if (problem) throw new HalfDoneRecordingError(task, resolved, problem);
  }
  const relative = path.relative(repoRoot, resolved).replace(/\\/g, "/");
  // --trace means that recording alone; otherwise recent ones teach branches
  const earlier = traceFile ? [] : await earlierTraces(task, resolved);
  const branched = compileTraces([...earlier, trace], relative);
  const others = branched.used.length - 1;
  // requirements the user gave before stay through a recompile; one typed now
  // must fit, one carried over may not (the steps may have changed)
  const carried = saved.require.filter(
    (r) => !(options.require ?? []).includes(r),
  );
  const typed = applyRequirements(
    branched.workflow,
    branched.recorded,
    options.require ?? [],
    true,
  );
  const required = applyRequirements(
    typed.workflow,
    branched.recorded,
    [...(typed.workflow.require ?? []), ...carried],
    false,
  );
  const workflow = workflowSchema.parse({
    ...writeBeforeActing(
      markCalculations(
        markDerived(
          markSelective(required.workflow, branched.recorded),
          branched.recorded,
          trace.meta.inputs,
        ),
        branched.recorded,
        trace.meta.inputs,
      ),
    ),
    compiledFrom:
      others > 0
        ? `${relative} (+${others} earlier recording${others === 1 ? "" : "s"})`
        : relative,
    baseline: await agentBaseline(trace),
    // a fresh recording is unconfirmed until the user says it is right
    confirmed: false,
    ...(readOnly ? { readOnly: true } : {}),
  });
  return {
    workflow,
    traceFile: resolved,
    warnings: [
      ...branched.warnings,
      ...required.warnings,
      ...recordingWarnings(trace, workflow, branched.recorded),
      ...recordingProblems(trace, workflow, branched.recorded),
    ],
    notes: [
      ...branched.notes,
      ...typed.applied,
      ...required.applied,
      ...strongNotes(workflow),
      ...decisionNotes(workflow),
    ],
  };
}

/** `require` of the workflow already on disk (none, or unreadable: nothing). */
/** What the owner chose for the saved workflow (--require, --read-only): kept by a recompile. */
async function previousSaved(
  task: string,
): Promise<{ require: string[]; readOnly: boolean }> {
  try {
    const raw = JSON.parse(
      await readFile(
        path.join(workflowsDir, `${assertTaskName(task)}.json`),
        "utf8",
      ),
    ) as { require?: unknown; readOnly?: unknown };
    return {
      require: Array.isArray(raw.require)
        ? raw.require.filter((r): r is string => typeof r === "string")
        : [],
      readOnly: raw.readOnly === true,
    };
  } catch {
    return { require: [], readOnly: false };
  }
}

/** The task's recordings before `newest`, oldest first; unreadable ones are skipped. */
async function earlierTraces(
  task: string,
  newest: string,
): Promise<TraceFile[]> {
  const dir = path.join(tracesDir, assertTaskName(task));
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const before = files
    .map((f) => path.join(dir, f))
    .filter((f) => f < newest)
    .slice(-(MAX_RECORDINGS - 1));
  const out: TraceFile[] = [];
  for (const file of before) {
    try {
      const t = await readTrace(file);
      if (t.meta.task === task && t.calls.some((c) => !c.isError)) out.push(t);
    } catch {
      // a broken or unfinished old recording just doesn't teach anything
    }
  }
  return out;
}

/**
 * Compile one recording held in memory, with no files read or written: the cloud
 * Studio records into memory and never stores the trace (it holds the tools' data).
 * The same passes as compileTaskInMemory with a single --trace and no --require.
 */
export function compileRecording(
  trace: TraceFile,
  compiledFrom: string,
  agentCostUsd?: number,
): { workflow: Workflow; warnings: string[] } {
  const branched = compileTraces([trace], compiledFrom);
  const required = applyRequirements(
    branched.workflow,
    branched.recorded,
    branched.workflow.require ?? [],
    false,
  );
  const start = Date.parse(trace.meta.startedAt);
  const end = Date.parse(trace.end.endedAt);
  const baseline: Workflow["baseline"] =
    Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? {
          durationMs: end - start,
          ...(agentCostUsd !== undefined && agentCostUsd >= 0
            ? { costUsd: agentCostUsd }
            : {}),
        }
      : undefined;
  const workflow = workflowSchema.parse({
    ...writeBeforeActing(
      markCalculations(
        markDerived(
          markSelective(required.workflow, branched.recorded),
          branched.recorded,
          trace.meta.inputs,
        ),
        branched.recorded,
        trace.meta.inputs,
      ),
    ),
    compiledFrom,
    baseline,
  });
  return {
    workflow,
    warnings: [
      ...branched.warnings,
      ...required.warnings,
      ...recordingWarnings(trace, workflow, branched.recorded),
      ...recordingProblems(trace, workflow, branched.recorded),
    ],
  };
}

/**
 * The recorded run's wall time, plus the agent's cost when the agent reported
 * one (the demo agent writes out/agent-run.json) while this trace was recorded.
 * A cost from another run is never borrowed.
 */
export async function agentBaseline(
  trace: TraceFile,
  agentRunFile = path.join(repoRoot, "out", "agent-run.json"),
): Promise<Workflow["baseline"]> {
  const start = Date.parse(trace.meta.startedAt);
  const end = Date.parse(trace.end.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }
  const baseline: NonNullable<Workflow["baseline"]> = {
    durationMs: end - start,
  };
  try {
    const { mtimeMs } = await stat(agentRunFile);
    // the agent writes its metrics right after its MCP session closes
    if (mtimeMs >= start - 5_000 && mtimeMs <= end + 120_000) {
      const run = JSON.parse(await readFile(agentRunFile, "utf8")) as {
        costUsd?: unknown;
      };
      if (typeof run.costUsd === "number" && run.costUsd >= 0) {
        baseline.costUsd = run.costUsd;
      }
    }
  } catch {
    // no agent metrics: cost stays unknown
  }
  return baseline;
}

export async function saveWorkflow(workflow: Workflow): Promise<void> {
  await mkdir(workflowsDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(workflowsDir, `${assertTaskName(workflow.task)}.json`),
    JSON.stringify(workflow, null, 2) + "\n",
  );
  const days = retainDays();
  if (days !== null) {
    // the trace this workflow came from: "traces/<task>/<file>.jsonl (+2 earlier …)"
    const from = path.basename(workflow.compiledFrom.split(" (")[0]!);
    const gone = await pruneTraces(
      path.join(tracesDir, assertTaskName(workflow.task)),
      from,
      days,
    );
    if (gone.length > 0) {
      console.log(
        `deleted ${gone.length} trace(s) of "${workflow.task}" older than ${days} days (HOTPATH_RETAIN_DAYS)`,
      );
    }
  }
}

/** "compiled 5 steps (dropped 4 failed/retried calls) → workflows/x.json (from …)" */
export function formatCompileResult(workflow: Workflow): string {
  const dropped = workflow.droppedCalls?.length ?? 0;
  const note =
    dropped > 0
      ? ` (dropped ${dropped} failed/retried call${dropped === 1 ? "" : "s"})`
      : "";
  return `compiled ${workflow.steps.length} steps${note} → workflows/${workflow.task}.json (from ${workflow.compiledFrom})`;
}

// `hotpath compile <task> [--trace <file>]` → workflows/<task>.json
export async function compileTask(
  task: string,
  traceFile?: string,
): Promise<Workflow> {
  const { workflow } = await compileTaskInMemory(task, traceFile);
  await saveWorkflow(workflow);
  return workflow;
}

/**
 * Read-only tool steps the old workflow had that the new one lacks (by tool
 * name and count), e.g. ["get_weather", "get_commits (1 of 3)"]. A recompile
 * from a run where the agent skipped reads would silently drop data sources.
 */
export function lostReadOnlySteps(old: Workflow, next: Workflow): string[] {
  const count = (w: Workflow) => {
    const counts = new Map<string, number>();
    for (const step of toolStepsOf(w.steps)) {
      if (!step.sideEffect) {
        counts.set(step.tool, (counts.get(step.tool) ?? 0) + 1);
      }
    }
    return counts;
  };
  const before = count(old);
  const after = count(next);
  const lost: string[] = [];
  for (const [tool, had] of before) {
    const has = after.get(tool) ?? 0;
    if (has >= had) continue;
    lost.push(has === 0 ? tool : `${tool} (${had - has} of ${had})`);
  }
  return lost;
}

/**
 * Action (side-effect) tools and AI steps the old workflow had that the new one
 * lacks, e.g. ["send_message", "AI step"]. A weak agent that answered in text
 * during a fallback would otherwise replace a working workflow with one that
 * reads everything and does nothing.
 */
export function lostActions(old: Workflow, next: Workflow): string[] {
  const actions = (w: Workflow) => {
    const counts = new Map<string, number>();
    for (const step of toolStepsOf(w.steps)) {
      if (step.sideEffect) {
        counts.set(step.tool, (counts.get(step.tool) ?? 0) + 1);
      }
    }
    return counts;
  };
  const llmCount = (w: Workflow) => llmStepsOf(w.steps).length;
  const before = actions(old);
  const after = actions(next);
  const lost: string[] = [];
  for (const [tool, had] of before) {
    const has = after.get(tool) ?? 0;
    if (has >= had) continue;
    lost.push(has === 0 ? tool : `${tool} (${had - has} of ${had})`);
  }
  if (llmCount(next) < llmCount(old)) lost.push("AI step");
  return lost;
}

/**
 * AI steps that had values to mention and now have none, e.g.
 * ["what the AI step s4 must mention"]. A fallback agent that wrote a
 * placeholder ("Emails: [Subject1, Subject2]") gives a workflow whose text is
 * checked against nothing; it must not replace one that was checked.
 */
export function lostGrounding(old: Workflow, next: Workflow): string[] {
  const llm = (w: Workflow) => llmStepsOf(w.steps);
  const before = llm(old);
  const after = llm(next);
  const lost: string[] = [];
  after.forEach((step, i) => {
    const was = before[i];
    if (!was || was.type !== "llm" || step.type !== "llm") return;
    const had = (was.guard.grounding ?? []).length > 0;
    const has = (step.guard.grounding ?? []).length > 0;
    if (had && !has) lost.push(`what the AI step ${step.id} must mention`);
  });
  return lost;
}

/**
 * Checks of the old workflow's AI steps that the recompile cannot rebuild: the
 * figures code recomputed and the rule that selected items. A recompile loses
 * them when the fallback agent's own report had a figure nothing explains (a
 * wrong total) or cited other items. Measured (drift suite, type change): the
 * recompiled workflow from such a report then sent a report without a total.
 */
export function lostChecks(old: Workflow, next: Workflow): string[] {
  const before = llmStepsOf(old.steps);
  const after = llmStepsOf(next.steps);
  const lost: string[] = [];
  after.forEach((step, i) => {
    const was = before[i];
    if (!was) return;
    const sums = (s: typeof step) => s.calculations?.length ?? 0;
    const rules = (s: typeof step) =>
      (s.guard.grounding ?? []).filter((g) => g.select).length;
    if (sums(step) < sums(was)) {
      lost.push(`the figures code calculates in ${step.id}`);
    }
    if (rules(step) < rules(was)) {
      lost.push(`the rule that selects the items of ${step.id}`);
    }
  });
  return lost;
}

/**
 * Problems with a recording worth telling the user before they trust the
 * compiled workflow: the server offered action tools but the agent never called
 * one (it usually wrote its answer as text instead of acting); the message
 * mentions nothing the agent read (a placeholder); or it covers a list only in
 * part (given `recorded`, each step's recorded result).
 */
export function recordingWarnings(
  trace: TraceFile,
  workflow: Workflow,
  recorded?: RecordedResult[],
): string[] {
  const warnings: string[] = [];
  if (trace.open) {
    warnings.push(
      `the trace is still open (the agent's client is still connected), so this ` +
        `compiled the ${trace.calls.length} tool calls recorded so far. If the agent ` +
        "was not finished, compile again when it is.",
    );
  }
  warnings.push(...hedgeWarnings(workflow));
  warnings.push(...positionalWarnings(workflow));
  const actionTools = trace.meta.tools
    .filter((t) => t.annotations?.readOnlyHint !== true)
    .map((t) => t.name);
  if (actionTools.length === 0 || workflow.readOnly) return warnings;
  const acted = toolStepsOf(workflow.steps).some((s) => s.sideEffect);
  if (acted) return [...warnings, ...coverageProblems(workflow, recorded)];
  warnings.push(
    `the agent never called an action tool (${actionTools.join(", ")}), so this ` +
      "workflow only reads data. It probably answered in text instead of acting; " +
      "record again (a stronger model, or a prompt that names the tool to call) " +
      "before relying on it.",
  );
  return warnings;
}

/**
 * Actions on items picked by position that rule 12 could not turn into a loop:
 * the runtime refuses to replay them, so the owner should know why every run
 * goes to the agent.
 */
export function positionalWarnings(workflow: Workflow): string[] {
  return (workflow.positional ?? []).map(
    (p) =>
      `${p.steps.join(", ")} act on items of ${p.list} by position (item 1, item 2…). ` +
      "A new day's list has other items in those places, so this workflow is never replayed: " +
      "the agent does the task each time. Record it again with the agent acting on the items " +
      "one after another, in the list's order.",
  );
}

/** What the replay model decides per item, and from how many recorded examples. */
export function decisionNotes(workflow: Workflow): string[] {
  return workflow.steps.flatMap((s) => {
    if (s.type !== "foreach" || !s.decide) return [];
    const counts = new Map<string, number>();
    for (const e of s.decide.examples) {
      const a = String(e.choice.action);
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    const seen = [...counts].map(([a, n]) => `${a} ×${n}`).join(", ");
    const once = [...counts].filter(([, n]) => n === 1).map(([a]) => a);
    return [
      `${s.id}: what to do with each ${s.as} is decided by the replay model on each run, ` +
        `from the recorded decisions (${seen}); code checks its answer before any action runs.` +
        (once.length > 0
          ? ` ${once.join(", ")} was recorded once: record another day where it happens to make the rule clearer.`
          : ""),
    ];
  });
}

// Phrases where the agent says it could not or did not do something.
const HEDGE =
  /\b(?:i |we )?(?:could not|couldn't|cannot|can't|did not|didn't|unable to|was not able to)\s+(?:\w+\s+){0,2}\w+|\bno [\w ]{0,20}(?:was|were) (?:retrieved|fetched|available|provided)|\bnot (?:verified|checked|confirmed)\b/i;

/**
 * A recorded text that admits a gap ("no GBP rate was retrieved") is copied by
 * every replay, true or not. Measured: a replay repeated that line for a
 * line the ledger had already matched. Tell the owner, who can record again.
 */
export function hedgeWarnings(workflow: Workflow): string[] {
  const out: string[] = [];
  for (const step of workflow.steps) {
    if (step.type !== "llm") continue;
    const sentence = step.example
      .split(/(?<=[.!?])\s+|\n/)
      .find((s) => HEDGE.test(s));
    if (!sentence) continue;
    const shown = sentence.trim().replace(/\s+/g, " ");
    const short = shown.length > 90 ? `${shown.slice(0, 87)}...` : shown;
    out.push(
      `${step.id}: the recorded text says the agent could not or did not do something ("${short}"). ` +
        "Every replay will repeat that. If it was a mistake or a leftover, record the task again with a clearer prompt.",
    );
  }
  return out;
}

function coverageProblems(
  workflow: Workflow,
  recorded: RecordedResult[] | undefined,
): string[] {
  if (!recorded) return [];
  const coverage = listCoverage(workflow, recorded);
  const out: string[] = [];
  const rest = coverage.filter((c) => {
    const step = workflow.steps.find((s) => s.id === c.step);
    const empty =
      step?.type === "llm" && (step.guard.grounding ?? []).length === 0;
    return !empty;
  });
  for (const step of workflow.steps) {
    if (step.type !== "llm" || (step.guard.grounding ?? []).length > 0)
      continue;
    if (!coverage.some((c) => c.step === step.id)) continue;
    out.push(
      `${step.id}: the recorded text mentions nothing from the data the agent read ` +
        "(no name, title or number from any result), so the workflow cannot check " +
        "what a replay writes. It is probably a placeholder: record the task again " +
        "before relying on it.",
    );
  }
  return [...out, ...coverageWarnings(rest)];
}

export async function loadWorkflow(task: string): Promise<Workflow> {
  const file = path.join(workflowsDir, `${assertTaskName(task)}.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(
      `no workflow for task "${task}" — run hotpath compile ${task} first`,
    );
  }
  return workflowSchema.parse(JSON.parse(raw));
}

// `s1 tool get_emails(date={{inputs.date}})` / `s4 llm (cheap) → s5.text`
// `s3 foreach email in {{steps.s1.result.emails}} (max 50)` + indented body
export function formatWorkflow(workflow: Workflow): string {
  const lines: string[] = [];
  const only = (when: Condition | undefined) =>
    when ? `  only if ${whenText(when)}` : "";
  const toolLine = (step: ToolStep, indent: string) => {
    const args = Object.entries(step.args)
      .map(([k, v]) => `${k}=${formatValue(v)}`)
      .join(", ");
    const mark = step.sideEffect ? " ⚡" : "";
    lines.push(
      `${indent}${step.id} tool ${step.tool}(${args})${mark}${only(step.when)}`,
    );
  };
  const render = (steps: Array<WorkflowStep | CaseStep>, indent: string) => {
    for (const step of steps) {
      if (step.type === "tool") {
        toolLine(step, indent);
      } else if (step.type === "foreach") {
        lines.push(
          `${indent}${step.id} foreach ${step.as} in ${step.over} (max ${step.maxItems}${step.distinct ? `, once per distinct ${step.distinct.join(".")}` : ""})${only(step.when)}`,
        );
        if (step.decide) {
          const choices = step.decide.actions
            .map((a) => {
              const fields = Object.keys(a.fields);
              return fields.length > 0
                ? `${a.tool}(${fields.join(", ")})`
                : a.tool;
            })
            .join(" | ");
          lines.push(
            `${indent}  decide per ${step.as} (llm ${step.decide.model}, ${step.decide.examples.length} recorded examples): ${choices} | none`,
          );
        }
        for (const body of step.body) toolLine(body, `${indent}  `);
      } else if (step.type === "branch") {
        lines.push(`${indent}${step.id} branch${only(step.when)}`);
        for (const c of step.cases) {
          lines.push(
            `${indent}  if ${whenText(c.when)}${c.label ? ` (${c.label})` : ""}:`,
          );
          render(c.steps, `${indent}    `);
        }
        if (step.else) {
          lines.push(`${indent}  otherwise:`);
          render(step.else, `${indent}    `);
        }
      } else {
        const consumer = findOutputConsumer(workflow, step.id);
        const arrow = consumer ? ` → ${consumer.stepId}.${consumer.arg}` : "";
        lines.push(
          `${indent}${step.id} llm (${step.model})${arrow}${only(step.when)}`,
        );
      }
    }
  };
  render(workflow.steps, "");
  return lines.join("\n");
}

export { whenText };

function findOutputConsumer(
  workflow: Workflow,
  llmId: string,
): { stepId: string; arg: string } | null {
  const tools = workflow.steps.flatMap((s) =>
    s.type === "foreach"
      ? s.body
      : s.type === "branch"
        ? [...s.cases.flatMap((c) => c.steps), ...(s.else ?? [])].flatMap(
            (inner) => (inner.type === "foreach" ? inner.body : [inner]),
          )
        : [s],
  );
  for (const step of tools) {
    if (step.type !== "tool") continue;
    for (const [arg, value] of Object.entries(step.args)) {
      if (value === `{{steps.${llmId}.output}}`)
        return { stepId: step.id, arg };
    }
  }
  return null;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export class UnconfirmedWorkflowError extends Error {
  constructor(readonly task: string) {
    super(
      `workflow "${task}" has not been confirmed — check what it recorded with ` +
        `"hotpath show ${task}", then run "hotpath confirm ${task}" ` +
        `(or recompile with "hotpath compile ${task} --yes")`,
    );
    this.name = "UnconfirmedWorkflowError";
  }
}

/** Workflows compiled before the check existed have no flag: confirmed. */
export function isConfirmed(workflow: Workflow): boolean {
  return workflow.confirmed !== false;
}

export function assertConfirmed(workflow: Workflow): void {
  if (!isConfirmed(workflow)) throw new UnconfirmedWorkflowError(workflow.task);
}

/** `hotpath confirm <task>`: mark the saved workflow as checked by the user. */
export async function confirmWorkflow(task: string): Promise<Workflow> {
  const workflow = { ...(await loadWorkflow(task)), confirmed: true };
  await saveWorkflow(workflow);
  return workflow;
}

const MAX_ARG_CHARS = 300;

const clip = (text: string) =>
  text.length > MAX_ARG_CHARS ? `${text.slice(0, MAX_ARG_CHARS)}…` : text;

/**
 * What the recorded run did, for the "is this right?" question: side-effect
 * calls (⚡, e.g. a message sent) with every argument, reads with one line.
 */
export function formatRecordingSummary(workflow: Workflow): string {
  // branch paths hold steps too: every recorded path is something it may do
  const flat = workflow.steps.flatMap((s) =>
    s.type === "branch"
      ? [...s.cases.flatMap((c) => c.steps), ...(s.else ?? [])]
      : [s],
  );
  const tools = flat.flatMap((s) =>
    s.type === "foreach" ? s.body : s.type === "tool" ? [s] : [],
  );
  const actions = tools.filter((t) => t.sideEffect);
  const reads = tools.filter((t) => !t.sideEffect);
  const lines = ["the recorded run did:"];
  // per-item decisions are where a weak recording goes wrong: show each one
  for (const s of flat) {
    if (s.type !== "foreach" || !s.decide) continue;
    lines.push(`  decided per item (${s.decide.examples.length} recorded):`);
    for (const ex of s.decide.examples.slice(0, 12)) {
      const name = s.decide.key.reduce<unknown>(
        (v, k) => (v as Record<string, unknown> | undefined)?.[k],
        ex.item,
      );
      const { action, ...fields } = ex.choice;
      const extra = Object.keys(fields).length
        ? ` ${clip(JSON.stringify(fields))}`
        : "";
      lines.push(`    ${formatValue(name)} → ${formatValue(action)}${extra}`);
    }
    if (s.decide.examples.length > 12)
      lines.push(`    … and ${s.decide.examples.length - 12} more`);
  }
  for (const t of actions) {
    lines.push(`  ⚡ ${t.tool}`);
    for (const [k, v] of Object.entries(t.args)) {
      lines.push(
        `      ${k}: ${clip(typeof v === "string" ? v : JSON.stringify(v))}`,
      );
    }
  }
  if (actions.length === 0) lines.push("  (no side-effect calls)");
  if (reads.length > 0) {
    lines.push(`  reads: ${reads.map((t) => t.tool).join(", ")}`);
  }
  const llm = workflow.steps.filter((s) => s.type === "llm").length;
  if (llm > 0) lines.push(`  ${llm} step(s) written by a model at run time`);
  return lines.join("\n");
}

export class HalfDoneRecordingError extends Error {
  constructor(
    readonly task: string,
    readonly traceFile: string,
    readonly problem: string,
  ) {
    super(
      `the recording of "${task}" (${path.basename(traceFile)}) looks half done: ${problem}. ` +
        "Nothing was compiled. If the agent stopped early (an error, a timeout, a model that " +
        "answered in text instead of acting), fix the cause and record it again. If this task " +
        `only reads, compile it with: hotpath compile ${task} --read-only`,
    );
    this.name = "HalfDoneRecordingError";
  }
}

/**
 * The agent read its data and stopped before its first action: the server offers
 * action tools but no call to one worked. A workflow from it would only read, and
 * every replay would "succeed" doing nothing. Null when the run acted, or the
 * server has nothing to act with.
 */
export function halfDoneRecording(trace: TraceFile): string | null {
  const actionTools = trace.meta.tools
    .filter((t) => t.annotations?.readOnlyHint !== true)
    .map((t) => t.name);
  if (actionTools.length === 0) return null;
  const acted = trace.calls.some(
    (c) => !c.isError && actionTools.includes(c.tool),
  );
  if (acted) return null;
  const counts = new Map<string, number>();
  for (const c of trace.calls)
    counts.set(c.tool, (counts.get(c.tool) ?? 0) + 1);
  const made = [...counts]
    .map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool))
    .join(", ");
  const last = trace.calls.at(-1);
  const ending =
    last?.isError === true
      ? `; its last call (${last.tool}) failed: ${clip(JSON.stringify(last.result)).slice(0, 160)}`
      : "";
  return (
    `it made ${trace.calls.length} call${trace.calls.length === 1 ? "" : "s"} (${made}) and never ` +
    `called an action tool (${actionTools.join(", ")})${ending}`
  );
}
