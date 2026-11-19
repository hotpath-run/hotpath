import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Ajv } from "ajv";
import crossSpawn from "cross-spawn";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  compileTaskInMemory,
  loadWorkflow,
  lostActions,
  lostChecks,
  lostGrounding,
  lostReadOnlySteps,
  saveWorkflow,
  workflowsDir,
} from "@hotpathrun/compiler";
import {
  answerKey,
  assertTaskName,
  AGENT_MODEL,
  CHEAP_MODEL,
  chat,
  countItems,
  DEFAULT_MAX_PAGES,
  mergePages,
  cheapMaxTokens,
  cheapReasoning,
  fillRows,
  formatMs,
  lookupReference,
  mentions,
  missingRates,
  unseenUnits,
  projectRoot,
  renderTemplate,
  scaledMaxChars,
  unwrapAnswer,
  usdCost,
  type CaseStep,
  type Condition,
  type GroundingEntry,
  type StepGuard,
  type TemplateContext,
  toolStepsOf,
  type ToolStep,
  type Workflow,
  type WorkflowStep,
} from "@hotpathrun/shared";

import {
  emptyLists,
  figureProblems,
  foreignAddresses,
  figuresPrompt,
  selectionHints,
  selectionMissing,
  todaysFigures,
} from "./checks.js";
import { Journal } from "./journal.js";
import {
  hostedMode,
  remoteServerUrl,
  remoteTransport,
} from "./tool-backends.js";

// the project folder (the repository in a checkout; see projectRoot)
const repoRoot = projectRoot();
const outDir = path.join(repoRoot, "out");

/** What the fallback hands to the agent command (`--task <task> --<input> <value>`). */
export interface AgentRequest {
  task: string;
  inputs: Record<string, string>;
}

export interface RunOptions {
  inputs: Record<string, string>;
  dryRun?: boolean;
  /** Stop on drift instead of running the agent (exit non-zero via DriftError). */
  noFallback?: boolean;
  /**
   * Replace the workflow after a fallback even if the recompile lost read-only
   * steps the old one had (default: warn and keep the old workflow).
   */
  acceptRecompile?: boolean;
  /**
   * When an llm step still leaves out values after its one retry, append them
   * ("Also: …") instead of treating it as drift. For small local models that
   * omit items while the data is fine. Default: HOTPATH_REPAIR_MENTIONS=1.
   */
  repairMentions?: boolean;
  /**
   * An llm step whose data is exactly what an earlier run (or the recorded
   * run) had reuses that answer instead of asking the model again. Default on;
   * HOTPATH_REUSE=0 turns it off.
   */
  reuse?: boolean;
  /**
   * Never ask a model: an AI step whose recorded text cannot be reused is
   * drift (verifyOnRecording uses it to check a workflow on its recording).
   */
  offline?: boolean;
  /** Override how the agent is run (tests); default spawns `agent` from hotpath.config.json. */
  runAgent?: (request: AgentRequest) => Promise<void>;
  /**
   * Where tool steps run. Default: the workflow's MCP server, started as a
   * command. @hotpathrun/sdk passes the agent's own functions instead.
   */
  tools?: ToolBackend;
}

/** Something that can run a tool by name: an MCP server, or functions in this process. */
export interface ToolBackend {
  call(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ value: unknown; isError: boolean }>;
  close?(): Promise<void>;
}

/** `server` of a workflow recorded from functions in the agent's own process. */
export const IN_PROCESS_SERVER = "in-process";

/** The workflow's MCP server, started from its recorded command (never a shell). */
async function mcpBackend(workflow: Workflow): Promise<ToolBackend> {
  if (workflow.server === IN_PROCESS_SERVER) {
    throw new Error(
      `"${workflow.task}" was recorded from tools that are functions in an agent's own code, ` +
        "so there is no server to start. Run it from that code with runWorkflow " +
        "from @hotpathrun/sdk, passing the same tools.",
    );
  }
  // an https:// server is a remote MCP endpoint (egress rules apply); in
  // hosted mode (HOTPATH_HOSTED=1) nothing else is allowed: starting the
  // recorded command would run any program a workflow file names
  const remote = remoteServerUrl(workflow.server, hostedMode());
  const serverArgv = workflow.serverArgv ?? splitCommand(workflow.server);
  const transport = remote
    ? remoteTransport(remote)
    : new StdioClientTransport({
        command: serverArgv[0],
        args: serverArgv.slice(1),
        cwd: await serverCwd(workflow.cwd),
        env: toolServerEnv(process.env),
        // no shell: the MCP SDK starts the server with cross-spawn (handles .cmd shims)
      });
  const client = new Client({ name: "@hotpathrun/runtime", version: "0.1.0" });
  await client.connect(transport);
  return {
    async call(tool, args) {
      const result = await client.callTool({ name: tool, arguments: args });
      return {
        value: extractResult(result),
        isError: (result as { isError?: boolean }).isError === true,
      };
    },
    close: () => client.close(),
  };
}

/**
 * Hotpath's own model keys, loaded from .env into this process. A tool server
 * is someone else's code and never needs them; passing them on would hand the
 * customer's model key to every recorded server.
 */
const HOTPATH_SECRETS = new Set([
  "LLM_API_KEY",
  "MOONSHOT_API_KEY",
  "GEMINI_KEY_SAVED",
]);

/** The environment a tool server starts with: ours, minus Hotpath's model keys. */
export function toolServerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !HOTPATH_SECRETS.has(name)) out[name] = value;
  }
  return out;
}

export interface StepRunResult {
  id: string;
  durationMs: number;
  ok: boolean;
  /** its condition (`when`) said this run does not make the step */
  skipped?: boolean;
}

export interface RunMetrics {
  durationMs: number;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  fallback: boolean;
  steps: StepRunResult[];
  /** time split: MCP server start + connect, tool steps, llm steps (all in ms) */
  connectMs: number;
  toolMs: number;
  /** llm steps' time, excluding rate-limit waiting (reported separately) */
  llmMs: number;
  /** time spent waiting on 429 retries (included in durationMs; agent's too after a fallback) */
  rateLimitWaitMs: number;
  /** tool calls actually made, in order (bench compares them with the trace) */
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** set when a guard failed */
  driftStep?: string;
  reason?: string;
  /** set when the agent fallback ran */
  agentDurationMs?: number;
  agentCostUsd?: number;
  /**
   * Where the money went, in dollars: a replay that finished, a replay that
   * was rejected (before a fallback), the agent run of a fallback, and the
   * recompile (code, no model call).
   */
  costBreakdown?: {
    successfulReplay: number;
    failedReplay: number;
    agentFallback: number;
    recompile: number;
  };
  /** why the first answer of an AI step was not accepted (it was asked again) */
  firstAttemptIssues?: string[];
  /** HOTPATH_KEEP_REJECTED=1: what the replay model wrote before a guard rejected it (every attempt) */
  rejectedOutputs?: string[];
  /** after a fallback: was workflows/<task>.json replaced by the recompile? */
  recompiled?: boolean;
  /** read-only steps the recompile would have dropped (see --accept-recompile) */
  lostSteps?: string[];
  /** llm steps whose output got missing values appended (repairMentions) */
  repairedSteps?: string[];
  /** llm steps answered from an earlier run with the same data (no model call) */
  reusedSteps?: string[];
  /** llm steps whose list rows were written by code (the model wrote the rest) */
  filledSteps?: string[];
  /** actions an interrupted run with the same inputs had done, not repeated */
  resumedActions?: string[];
}

/** A step's guard failed: the workflow no longer matches reality. */
export class DriftError extends Error {
  constructor(
    readonly stepId: string,
    readonly reason: string,
    /** a side-effect step had already run, so re-running the task would repeat it */
    readonly sideEffectRan: boolean,
    readonly metrics: RunMetrics,
  ) {
    super(`drift at ${stepId}: ${reason}`);
    this.name = "DriftError";
  }
}

export async function runTask(
  task: string,
  options: RunOptions,
): Promise<RunMetrics> {
  const workflow = await loadWorkflow(task);
  try {
    return await runWorkflow(workflow, options);
  } catch (err) {
    if (!(err instanceof DriftError)) throw err;
    console.log(`⚠ drift at ${err.stepId}: ${err.reason}`);
    if (options.noFallback || options.dryRun) {
      throw new DriftError(
        err.stepId,
        `${err.reason} (${options.dryRun ? "--dry-run" : "--no-fallback"}: agent not run)`,
        err.sideEffectRan,
        err.metrics,
      );
    }
    // hosted mode: the configured agent is a local command too; a remote agent
    // endpoint is not built yet, so drift stops the run instead
    if (hostedMode() && !options.runAgent) {
      throw new DriftError(
        err.stepId,
        `${err.reason} — hosted mode does not start a local agent; the run stopped`,
        err.sideEffectRan,
        err.metrics,
      );
    }
    if (err.sideEffectRan) {
      // The agent would repeat the side effect (e.g. send the message twice).
      throw new DriftError(
        err.stepId,
        `${err.reason} — a side effect already ran, so the agent was not run; ` +
          "fix the workflow or re-record with hotpath record",
        true,
        err.metrics,
      );
    }
    return fallback(workflow, options, err);
  }
}

async function fallback(
  workflow: Workflow,
  options: RunOptions,
  drift: DriftError,
): Promise<RunMetrics> {
  const task = assertTaskName(workflow.task);
  const agentStart = Date.now();
  console.log(`↻ falling back to the agent for "${task}"…`);
  await (options.runAgent ?? runConfiguredAgent)({
    task,
    inputs: options.inputs,
  });
  const agentDurationMs = Date.now() - agentStart;
  const agent = await readAgentRun(agentStart);
  const agentCostUsd = agent.costUsd;

  // Recompile from the trace the agent just wrote, but look before replacing:
  // if the agent skipped reads the old workflow had, the new one would
  // silently lose those data sources.
  const { workflow: next } = await compileTaskInMemory(task);
  // Also refuse to drop actions or AI steps: a small model that answered in
  // text during the fallback would leave a workflow that only reads.
  const lostReads = lostReadOnlySteps(workflow, next);
  const lostActs = lostActions(workflow, next);
  // …nor one whose message mentions nothing it read (a placeholder): its text
  // would be checked against nothing, and reused as is on the same data.
  const lostFacts = lostGrounding(workflow, next);
  // …nor one that lost the figures code recomputes or the selection rule: the
  // agent's own report was what changed them (a wrong total, other items)
  const lostRules = lostChecks(workflow, next);
  const lostSteps = [...lostReads, ...lostActs, ...lostFacts, ...lostRules];
  const replace = lostSteps.length === 0 || options.acceptRecompile === true;
  let backup: string | null = null;
  if (replace) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = path.join(workflowsDir, `${task}.${stamp}.bak.json`);
    await copyFile(path.join(workflowsDir, `${task}.json`), backup);
    await saveWorkflow(next);
  } else {
    const what = [
      lostReads.length > 0 ? `read-only step(s): ${lostReads.join(", ")}` : "",
      lostActs.length > 0 ? `action step(s): ${lostActs.join(", ")}` : "",
      lostFacts.length > 0
        ? `${lostFacts.join(", ")} (the agent's text mentions nothing from the data)`
        : "",
      lostRules.length > 0
        ? `${lostRules.join(", ")} (the agent's report has figures or items they do not explain)`
        : "",
    ]
      .filter(Boolean)
      .join("; and ");
    console.log(
      `⚠ the recompiled workflow lost ${what} that the previous one had. ` +
        `Keeping the old workflow (workflows/${task}.json is unchanged); ` +
        "pass --accept-recompile to replace it anyway.",
    );
  }

  const metrics: RunMetrics = {
    ...drift.metrics,
    durationMs: drift.metrics.durationMs + agentDurationMs,
    costUsd: drift.metrics.costUsd + agentCostUsd,
    costBreakdown: {
      successfulReplay: 0,
      failedReplay: drift.metrics.costUsd,
      agentFallback: agentCostUsd,
      recompile: 0,
    },
    rateLimitWaitMs: drift.metrics.rateLimitWaitMs + agent.rateLimitWaitMs,
    fallback: true,
    driftStep: drift.stepId,
    reason: drift.reason,
    agentDurationMs,
    agentCostUsd,
    recompiled: replace,
    ...(lostSteps.length > 0 ? { lostSteps } : {}),
  };
  await writeMetrics(metrics);
  console.log(
    `✓ ${task} recovered via agent in ${(metrics.durationMs / 1000).toFixed(1)}s, ` +
      `$${metrics.costUsd.toFixed(4)}; ` +
      (backup
        ? `recompiled ${next.steps.length} steps (old workflow: ${path.relative(repoRoot, backup).replace(/\\/g, "/")})`
        : "old workflow kept"),
  );
  return metrics;
}

// Start the server where it was recorded (a wrapped agent server may use
// relative paths); fall back to the repo root when that folder is gone.
async function serverCwd(recorded: string | undefined): Promise<string> {
  if (!recorded) return repoRoot;
  try {
    return (await stat(recorded)).isDirectory() ? recorded : repoRoot;
  } catch {
    return repoRoot;
  }
}

async function runConfiguredAgent(request: AgentRequest): Promise<void> {
  const config = JSON.parse(
    await readFile(path.join(repoRoot, "hotpath.config.json"), "utf8"),
  ) as { tasks: Record<string, { agent: string }> };
  const entry = config.tasks[request.task];
  if (!entry) {
    throw new Error(
      `task "${request.task}" not found in hotpath.config.json — add it, or pass --no-fallback`,
    );
  }
  await runAgentCommand(entry.agent, request);
}

// Input names become `--<name>` flags, so they are restricted to a safe shape.
const INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * argv for the fallback agent: the configured command's words, then
 * `--task <task>` and `--<input> <value>` for every input, each as its own
 * item. Nothing is ever joined into a string a shell would parse, so a value
 * such as `$(rm -rf ~)` reaches the agent as that literal text.
 */
export function buildAgentArgv(
  agentCommand: string,
  request: AgentRequest,
): string[] {
  const argv = splitCommand(agentCommand);
  if (argv.length === 0) {
    throw new Error(
      `the "agent" command for task "${request.task}" in hotpath.config.json is empty — set it, or pass --no-fallback`,
    );
  }
  argv.push("--task", request.task);
  for (const [name, value] of Object.entries(request.inputs)) {
    if (!INPUT_NAME_RE.test(name)) {
      throw new Error(
        `invalid input name ${JSON.stringify(name)} — input names may only contain letters, digits, "_" and "-", and must start with a letter or "_" (it becomes the flag --${name})`,
      );
    }
    argv.push(`--${name}`, value);
  }
  return argv;
}

/** Runs the agent with an argv (cross-spawn handles Windows shims), never via a shell. */
export async function runAgentCommand(
  agentCommand: string,
  request: AgentRequest,
): Promise<void> {
  const [file, ...args] = buildAgentArgv(agentCommand, request);
  const printable = [file, ...args].join(" ");
  await new Promise<void>((resolve, reject) => {
    const child = crossSpawn(file, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (err) =>
      reject(
        new Error(
          `could not start the agent (${printable}): ${err.message} — check the "agent" command in hotpath.config.json`,
        ),
      ),
    );
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `agent command failed (exit ${code}): ${printable} — check the agent output above`,
            ),
          ),
    );
  });
}

// The demo agent writes out/agent-run.json; other agents may not (then $0).
async function readAgentRun(
  since: number,
): Promise<{ costUsd: number; rateLimitWaitMs: number }> {
  const none = { costUsd: 0, rateLimitWaitMs: 0 };
  try {
    const file = path.join(outDir, "agent-run.json");
    const { mtimeMs } = await stat(file);
    if (mtimeMs < since - 1000) return none;
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      costUsd?: number;
      rateLimitWaitMs?: number;
    };
    return {
      costUsd: typeof parsed.costUsd === "number" ? parsed.costUsd : 0,
      rateLimitWaitMs:
        typeof parsed.rateLimitWaitMs === "number" ? parsed.rateLimitWaitMs : 0,
    };
  } catch {
    return none;
  }
}

export async function runWorkflow(
  workflow: Workflow,
  options: RunOptions,
): Promise<RunMetrics> {
  const missing = Object.entries(workflow.inputs).filter(
    ([name]) => !(name in options.inputs),
  );
  if (missing.length > 0) {
    const listing = missing
      .map(
        ([name, def]) => `  ${name} (example: ${JSON.stringify(def.example)})`,
      )
      .join("\n");
    throw new Error(
      `missing required input(s) for "${workflow.task}":\n${listing}\n` +
        "pass them as --input key=value",
    );
  }

  const start = Date.now();
  const backend = options.tools ?? (await mcpBackend(workflow));
  const connectMs = Date.now() - start;

  const ctx: TemplateContext = { inputs: options.inputs, steps: {} };
  const steps: StepRunResult[] = [];
  let llmCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  // dollars, summed per call: a step may be written by a different model
  let llmCostUsd = 0;
  let sideEffectRan = false;
  let toolMs = 0;
  let llmMs = 0;
  let rateLimitWaitMs = 0;
  const toolCalls: RunMetrics["toolCalls"] = [];
  const repairMentions =
    options.repairMentions ?? process.env.HOTPATH_REPAIR_MENTIONS === "1";
  const repairedSteps: string[] = [];
  const reuse = options.reuse ?? process.env.HOTPATH_REUSE !== "0";
  const reusedSteps: string[] = [];
  const filledSteps: string[] = [];
  const answers = reuse ? await loadAnswers(workflow.task) : {};
  const modelAnswers: string[] = [];
  const firstAttemptIssues: string[] = [];
  // a journal only for runs that act (see journal.ts); dry runs never act
  const acts = toolStepsOf(workflow.steps).some((s) => s.sideEffect);
  const journal =
    acts && !options.dryRun && process.env.HOTPATH_JOURNAL !== "0"
      ? await Journal.open(
          path.join(
            repoRoot,
            ".hotpath",
            "journal",
            assertTaskName(workflow.task),
          ),
          workflow.task,
          options.inputs,
        )
      : null;
  const resumedActions: string[] = [];

  const buildMetrics = (extra: Partial<RunMetrics> = {}): RunMetrics => ({
    durationMs: Date.now() - start,
    llmCalls,
    promptTokens,
    completionTokens,
    costUsd: llmCostUsd,
    fallback: false,
    steps,
    connectMs,
    toolMs,
    llmMs,
    rateLimitWaitMs,
    toolCalls,
    ...(repairedSteps.length > 0 ? { repairedSteps } : {}),
    ...(reusedSteps.length > 0 ? { reusedSteps } : {}),
    ...(filledSteps.length > 0 ? { filledSteps } : {}),
    ...(resumedActions.length > 0 ? { resumedActions } : {}),
    ...(firstAttemptIssues.length > 0 ? { firstAttemptIssues } : {}),
    // opt-in: the text a guard rejected can hold customer data
    ...(extra.driftStep && process.env.HOTPATH_KEEP_REJECTED === "1"
      ? { rejectedOutputs: modelAnswers }
      : {}),
    ...(extra.driftStep
      ? {}
      : {
          costBreakdown: {
            successfulReplay: llmCostUsd,
            failedReplay: 0,
            agentFallback: 0,
            recompile: 0,
          },
        }),
    ...extra,
  });

  // Runs one tool step; returns a drift reason, or null when its guard passes.
  const callTool = async (
    step: ToolStep,
    label: string,
  ): Promise<string | null> => {
    const args = renderTemplate(step.args, ctx) as Record<string, unknown>;
    if (step.sideEffect && options.dryRun) {
      console.log(
        `dry-run: ${label} ${step.tool} would send ${JSON.stringify(args)}`,
      );
      return null;
    }
    // Crash safety (journal.ts): an action an interrupted run with the same
    // inputs already did is not done again; one it started and never
    // confirmed may have happened, so the run stops for a person to check.
    if (step.sideEffect && journal && !step.repeatable) {
      const done = journal.done(label);
      if (done) {
        console.log(
          `↷ ${label}: ${step.tool} already ran in an interrupted run with the same inputs, not repeated`,
        );
        sideEffectRan = true;
        resumedActions.push(label);
        ctx.steps[step.id] = { result: done.result };
        return null;
      }
      if (journal.unconfirmed(label)) {
        sideEffectRan = true; // it may have acted: never let the agent repeat it
        return (
          `${label}: ${step.tool} was started by an interrupted run with the same inputs and never confirmed, ` +
          "so it may already have happened. Check, then run again after deleting " +
          `.hotpath/journal/${workflow.task}, or mark the step "repeatable" in the workflow`
        );
      }
      await journal.started(label);
    }
    toolCalls.push({ tool: step.tool, args });
    // A read that fails once (a 503, a timeout) is usually fine a moment later.
    // Only reads are repeated: a side effect might already have happened.
    const callOnce = async (a: Record<string, unknown>) => {
      const first = await backend.call(step.tool, a);
      return first.isError && !step.sideEffect
        ? backend.call(step.tool, a)
        : first;
    };
    const first = await callOnce(args);
    const { isError } = first;
    let value = first.value;
    // a paginated read: ask again until the result names no next page
    const pages = step.paginate;
    if (pages && !step.sideEffect && !isError) {
      const max = pages.maxPages ?? DEFAULT_MAX_PAGES;
      let last = value;
      let count = 1;
      while (isPageRecord(last) && last[pages.next] != null) {
        if (count >= max) {
          ctx.steps[step.id] = { result: value };
          return `${label}: more than ${max} pages of ${step.tool}`;
        }
        toolCalls.push({
          tool: step.tool,
          args: { ...args, [pages.arg]: last[pages.next] },
        });
        const page = await callOnce({ ...args, [pages.arg]: last[pages.next] });
        if (page.isError) {
          ctx.steps[step.id] = { result: page.value };
          return `${label}: tool ${step.tool} returned an error on page ${count + 1}: ${previewOf(page.value)}`;
        }
        value = mergePages(value, page.value, pages.next);
        last = page.value;
        count++;
      }
    }
    if (step.sideEffect) sideEffectRan = true;
    ctx.steps[step.id] = { result: value };
    // an action that answered with an error may still have acted: it stays
    // "started" (unconfirmed) in the journal
    if (step.sideEffect && journal && !isError) {
      await journal.finished(label, value);
    }
    if (isError) {
      return `${label}: tool ${step.tool} returned an error: ${previewOf(value)}`;
    }
    const failure = checkToolGuard(step.guard, value);
    return failure && label !== step.id ? `${label}: ${failure}` : failure;
  };

  try {
    const runStep = async (step: WorkflowStep | CaseStep): Promise<void> => {
      const stepStart = Date.now();
      let stepWaitMs = 0; // rate-limit waiting inside this step
      const record = (ok: boolean) => {
        const durationMs = Date.now() - stepStart;
        steps.push({ id: step.id, durationMs, ok });
        if (step.type === "llm") llmMs += Math.max(0, durationMs - stepWaitMs);
        else toolMs += durationMs;
      };
      const drift = async (reason: string): Promise<never> => {
        record(false);
        const metrics = buildMetrics({ driftStep: step.id, reason });
        await writeMetrics(metrics);
        throw new DriftError(step.id, reason, sideEffectRan, metrics);
      };

      // Decide a condition: a rule in code, or one yes/no question to the model.
      const decide = async (when: Condition): Promise<boolean> => {
        const rule = checkCondition(when, ctx);
        if (rule !== null || when.kind !== "ask") return rule === true;
        const result = await chat({
          model: CHEAP_MODEL,
          messages: [{ role: "user", content: askPrompt(when, ctx) }],
          reasoningEffort: cheapReasoning(),
          maxTokens: cheapMaxTokens(),
        });
        llmCalls += result.llmCalls;
        promptTokens += result.promptTokens;
        completionTokens += result.completionTokens;
        llmCostUsd += usdCost(
          CHEAP_MODEL,
          result.promptTokens,
          result.completionTokens,
        );
        // a wait inside a decision belongs to this step too, not to its llm/tool time
        stepWaitMs += result.rateLimitWaitMs ?? 0;
        rateLimitWaitMs += result.rateLimitWaitMs ?? 0;
        const answer = parseYesNo(result.text ?? "");
        if (answer === null) {
          await drift(
            `could not decide whether to ${when.question}: the model answered ${JSON.stringify((result.text ?? "").slice(0, 80))} instead of yes or no`,
          );
        }
        return answer === true;
      };

      // A step only some recordings made: decide whether this run makes it.
      if (step.when) {
        if (!(await decide(step.when))) {
          steps.push({
            id: step.id,
            durationMs: Date.now() - stepStart,
            ok: true,
            skipped: true,
          });
          console.log(`↷ ${step.id}: skipped (${conditionText(step.when)})`);
          return;
        }
      }

      // Different recordings took different paths: run the first case that fits.
      if (step.type === "branch") {
        for (const [i, c] of step.cases.entries()) {
          if (!(await decide(c.when))) continue;
          console.log(
            `⑂ ${step.id}: took the case ${i + 1}${c.label ? ` (${c.label})` : ""}: ${conditionText(c.when)}`,
          );
          for (const inner of c.steps) await runStep(inner);
          record(true);
          return;
        }
        if (step.else) {
          console.log(`⑂ ${step.id}: no case fits, took the otherwise path`);
          for (const inner of step.else) await runStep(inner);
          record(true);
          return;
        }
        // Never seen before: drift, so the agent runs once and the next compile learns it.
        await drift(
          `none of the ${step.cases.length} recorded paths fits this run's data (${step.cases.map((c) => conditionText(c.when)).join("; ")}). ` +
            "This situation was never recorded: the agent will do it, and the new recording becomes another path.",
        );
        return;
      }

      if (step.type === "llm") {
        // The example is from the recorded run: without the warning, small
        // models copy its facts instead of using this run's data.
        const dataPrompt = renderTemplate(step.prompt, ctx) as string;
        const key = answerKey(step.example, dataPrompt);
        const known = !reuse
          ? undefined
          : key === step.inputKey
            ? step.example
            : answers[key]?.output;
        // Same question as before: no thinking needed at all. A saved answer
        // passed every guard on this exact data, so it would again. The
        // recorded example never went through them: an agent may have left
        // items out (measured with a 1.7B agent), so it must pass them now.
        const fromRecording = known !== undefined && key === step.inputKey;
        if (
          known !== undefined &&
          checkLlmGuard(step.guard, known) === null &&
          (!fromRecording ||
            (checkGrounding(step.guard.grounding, ctx, known).length === 0 &&
              checkStale(step.guard.exampleFacts, ctx, known).length === 0 &&
              figureProblems(todaysFigures(step.calculations, ctx), ctx, known)
                .missing.length === 0))
        ) {
          console.log(
            `↺ ${step.id}: same data as an earlier run, reused its answer (HOTPATH_REUSE=0 to always ask the model)`,
          );
          reusedSteps.push(step.id);
          ctx.steps[step.id] = { output: known };
          record(true);
          return;
        }
        // Rows the compiler found (one line per item of a list) are written by
        // code: the model is shown the text without them and writes the rest.
        const layout =
          step.layout && process.env.HOTPATH_LAYOUT !== "0"
            ? step.layout
            : undefined;
        // A selection (see `selective`) is not "every item": say what to do instead.
        const askedData = step.selective
          ? dataPrompt.replace(
              "and cover every item in it.",
              "and work out the figures from it. " + SELECTIVE_NOTE,
            )
          : dataPrompt;
        // What code works out from today's data: the items the recorded rule
        // selects, and the figures it calculated. The model writes around them.
        // a figure the recording calculated needs a rate this run never read
        // (a new currency): the model would guess it, so the agent does it
        const unread = [
          ...new Set(
            (step.calculations ?? []).flatMap((c) => missingRates(c, ctx)),
          ),
        ];
        if (unread.length > 0) {
          await drift(
            `today's data needs an exchange rate the workflow does not read (${unread.join(", ")}), ` +
              "so the calculated figures cannot be checked; the agent will do it, and the new recording teaches the workflow",
          );
        }
        // a currency the recording never saw, in figures added without a rate
        const unseen = [
          ...new Set(
            (step.calculations ?? []).flatMap((c) => unseenUnits(c, ctx)),
          ),
        ];
        if (unseen.length > 0) {
          await drift(
            `today's items include a currency the recording never saw (${unseen.join(", ")}), ` +
              "and the workflow adds amounts without converting them; the agent will do it, and the new recording teaches the workflow",
          );
        }
        const empty = emptyLists(step.calculations, step.guard.grounding, ctx);
        if (empty.length > 0) {
          await drift(
            `${empty.join(", ")} ${empty.length === 1 ? "is" : "are"} empty today, and the recording never showed ` +
              "what to write then; the agent will do it, and the new recording teaches the workflow",
          );
        }
        const figures = todaysFigures(step.calculations, ctx);
        const hints = selectionHints(step.guard.grounding, ctx);
        const computed = [
          ...(hints.length > 0 ? [hints.join("\n")] : []),
          ...(figures.length > 0 ? [figuresPrompt(figures)] : []),
        ];
        const withDerived =
          (step.derived?.length
            ? `${askedData}\n\n` +
              "In the example, these lines hold figures the agent calculated from the data " +
              "(<calculated>): write lines like them with the figures calculated from the data above, " +
              "and do not leave them out:\n" +
              step.derived.map((l) => `  ${l}`).join("\n")
            : askedData) +
          (computed.length > 0 ? `\n\n${computed.join("\n\n")}` : "");
        // every guard on what the text says: grounding and calculated figures
        // missing, example facts and the recorded figures copied
        const contentIssues = (t: string) => {
          const figs = figureProblems(figures, ctx, t);
          return {
            missing: [
              ...checkGrounding(step.guard.grounding, ctx, t),
              ...figs.missing,
            ],
            stale: [
              ...checkStale(step.guard.exampleFacts, ctx, t),
              ...figs.stale,
            ],
          };
        };
        const prompt = layout
          ? `${withDerived}\n\n` +
            "Use only the data above. The example below comes from an earlier run on different data, so its facts must not be copied. " +
            `In it, each line like ${layout.rows[0]!.marker} stands for a list that is filled in from the data afterwards ` +
            `(${layout.rows.map((r) => `${r.marker}: ${r.over.split(".").slice(3).join(".") || "the items"}`).join("; ")}). ` +
            "Copy each of those lines exactly, once, on its own line, and do not write those lists yourself. " +
            `Match the style and length of this example, roughly: ${layout.skeleton}\n\n` +
            REPLY_ONLY
          : `${withDerived}\n\n` +
            "Use only the data above. The example below comes from an earlier run on different data, so its facts must not be copied. " +
            `Match the style and length of this example, roughly: ${step.example}\n\n` +
            REPLY_ONLY;
        // The retry goes without the example: shown it again, qwen3 1.7B
        // copied its facts on most retries (measured), even when the first
        // answer had only left something out. On a retry, facts beat style.
        const retryPrompt =
          `${withDerived}\n\n` +
          `Use only the data above. Keep it to about ${lineCount(step.example)} lines. ${REPLY_ONLY}`;
        // A step with calculated figures is written by the stronger model (see `model: "strong"`).
        const writer = step.model === "strong" ? AGENT_MODEL : CHEAP_MODEL;
        if (writer !== CHEAP_MODEL) {
          console.log(
            `↑ ${step.id}: written by ${writer}: the recorded text holds calculated figures`,
          );
        }
        const maxTokens = cheapMaxTokens();
        const ask = async (content: string): Promise<string> => {
          const result = await chat({
            model: writer,
            messages: [{ role: "user", content }],
            reasoningEffort: cheapReasoning(),
            maxTokens,
          });
          llmCalls += result.llmCalls;
          promptTokens += result.promptTokens;
          completionTokens += result.completionTokens;
          llmCostUsd += usdCost(
            writer,
            result.promptTokens,
            result.completionTokens,
          );
          stepWaitMs += result.rateLimitWaitMs ?? 0;
          rateLimitWaitMs += result.rateLimitWaitMs ?? 0;
          // kept before the truncation check, so a cut-off answer is visible too
          modelAnswers.push(result.text ?? "");
          if (result.truncated) {
            await drift(
              `llm stopped at the ${maxTokens}-token cap (HOTPATH_CHEAP_MAX_TOKENS): ` +
                "the model thought too long. Raise the cap, or replay with a model " +
                "that thinks less (or HOTPATH_CHEAP_REASONING=none)",
            );
          }
          return unwrapAnswer(result.text ?? "");
        };
        // offline (a check of the workflow on its own recording): no model is
        // asked. On the recorded data the recorded text was reused above when
        // it passes every check; reaching here means it does not.
        if (options.offline) {
          const { missing, stale } = contentIssues(step.example);
          const why = [
            checkLlmGuard(step.guard, step.example) ?? "",
            missing.length > 0 ? `does not mention ${missing.join("; ")}` : "",
            stale.length > 0 ? `repeats ${stale.join("; ")}` : "",
            key !== step.inputKey
              ? "the data differs from the recording (a tool step read something else)"
              : "",
          ].filter(Boolean);
          await drift(
            `the recorded text does not pass this workflow's own checks on the recorded data: ${why.join(" | ") || "unknown"}`,
          );
        }
        let text = await ask(prompt);
        // the length guard is about what the model wrote: rows grow with the data
        const todayItems = countItems(
          Object.values(ctx.steps).map((s) => s.result),
        );
        let failure = checkLlmGuard(step.guard, text, todayItems);
        if (failure) await drift(failure);
        if (layout) {
          // A text without the markers is a complete text (the model wrote the
          // lists itself): it goes through the guards as it is.
          const filled = fillRows(text, layout.rows, ctx);
          if (filled !== null) {
            text = filled;
            filledSteps.push(step.id);
          }
        }

        // Grounding guard: the output must mention this run's values (not
        // just the example's), and must not repeat example facts that are no
        // longer in the data. Ask once more.
        let { missing, stale } = contentIssues(text);
        if (missing.length > 0 || stale.length > 0) {
          firstAttemptIssues.push(
            `${step.id}: ${[
              missing.length > 0 ? `left out: ${missing.join("; ")}` : "",
              stale.length > 0
                ? `copied from the example: ${stale.join("; ")}`
                : "",
            ]
              .filter(Boolean)
              .join(" | ")}`,
          );
          // Copied facts are not named: listing them made the model write them
          // again (measured).
          const leftOut =
            missing.length > 0
              ? "Your previous answer left out these items from the data, " +
                "which must all appear in the text (verbatim):\n" +
                `${missing.map((m) => `- ${m}`).join("\n")}\n`
              : "";
          // A text that only leaves something out is repaired, not rewritten:
          // the model gets its own answer back (built from this run's data, so
          // nothing to copy) and adds what is missing. Rewriting from scratch
          // without the example made weak models lose the format and drift
          // (measured on morning-brief: the first answer lacked only the date).
          // With copied facts the old way stays: the previous text is the problem.
          const previous =
            // HOTPATH_REPAIR_RETRY=0: the old rewrite-from-scratch retry (to measure the difference)
            process.env.HOTPATH_REPAIR_RETRY !== "0" &&
            stale.length === 0 &&
            missing.length > 0
              ? `Your previous answer:\n"""\n${text}\n"""\n\n`
              : "";
          text = await ask(
            `${retryPrompt}\n\n${previous}${leftOut}` +
              (previous
                ? "Write the complete text again: keep what is already right, add what is missing, use only the data above."
                : "Write the complete text again, using only the data above."),
          );
          failure = checkLlmGuard(step.guard, text, todayItems);
          if (failure) await drift(failure);
          // a copied fact can't be repaired by appending, so it is always drift
          ({ missing, stale } = contentIssues(text));
          if (stale.length > 0) {
            await drift(
              `llm output repeats facts that are not in this run's data: ${stale.join("; ")} ` +
                "(copied from the recorded example; stale-fact guard)",
            );
          }
          if (missing.length > 0 && repairMentions) {
            text = `${text.trimEnd()}\n\nAlso: ${missing.join("; ")}.`;
            repairedSteps.push(step.id);
            console.log(
              `⚠ ${step.id}: appended values the model left out: ${missing.join("; ")}`,
            );
          } else if (missing.length > 0) {
            await drift(
              `llm output does not mention: ${missing.join("; ")} (grounding guard)`,
            );
          }
        }
        // a link or address nobody gave the model: the shape of an injection
        // that sends the data elsewhere (HOTPATH_LINK_GUARD=0 turns it off)
        const planted = foreignAddresses(text, ctx, step.example);
        if (planted.length > 0 && process.env.HOTPATH_LINK_GUARD !== "0") {
          await drift(
            `llm output contains links or addresses that are in none of the data: ${planted.join(", ")} ` +
              "(link guard: text that points somewhere nobody gave is how a prompt injection carries data out)",
          );
        }
        ctx.steps[step.id] = { output: text };
        if (reuse) await saveAnswer(workflow.task, answers, key, text);
        record(true);
        return;
      }

      if (step.type === "foreach") {
        const list = renderTemplate(step.over, ctx);
        if (!Array.isArray(list)) {
          await drift(
            `${step.over} is not a list any more (got ${previewOf(list)})`,
          );
        }
        const all = list as unknown[];
        if (all.length > step.maxItems) {
          console.log(
            `⚠ ${step.id}: ${all.length} items, running the first ${step.maxItems} (maxItems)`,
          );
        }
        const items = all.slice(0, step.maxItems);
        const results: unknown[] = [];
        for (const [i, item] of items.entries()) {
          ctx.vars = { ...ctx.vars, [step.as]: item };
          let acted = false;
          for (const body of step.body) {
            if (body.when && !(await decide(body.when))) continue;
            const failure = await callTool(
              body,
              `${body.id} (item ${i + 1} of ${items.length})`,
            );
            if (failure) await drift(failure);
            acted = true;
          }
          const last = step.body[step.body.length - 1]!;
          if (acted) results.push(ctx.steps[last.id]?.result);
        }
        if (ctx.vars) delete ctx.vars[step.as];
        ctx.steps[step.id] = { results };
        record(true);
        return;
      }

      const failure = await callTool(step, step.id);
      if (failure) await drift(failure);
      record(true);
    };
    for (const step of workflow.steps) await runStep(step);
  } finally {
    await backend.close?.();
  }
  // the run reached its end: the next run with these inputs is a new one
  await journal?.close();

  const metrics = buildMetrics();
  await writeMetrics(metrics);
  const calls =
    metrics.llmCalls === 1 ? "1 llm call" : `${metrics.llmCalls} llm calls`;
  console.log(
    `✓ ${workflow.task} in ${(metrics.durationMs / 1000).toFixed(1)}s, $${metrics.costUsd.toFixed(4)} (${calls})` +
      ` · startup ${formatMs(metrics.connectMs)} + tools ${formatMs(metrics.toolMs)} + llm ${formatMs(metrics.llmMs)}` +
      (metrics.rateLimitWaitMs > 0
        ? ` (+${formatMs(metrics.rateLimitWaitMs)} rate-limit wait)`
        : ""),
  );
  return metrics;
}

/** Answers kept per task: enough for reruns and retries, small on disk. */
const MAX_ANSWERS = 50;

type AnswerStore = Record<string, { output: string; savedAt: string }>;

const answersFile = (task: string) =>
  path.join(repoRoot, ".hotpath", "answers", `${assertTaskName(task)}.json`);

async function loadAnswers(task: string): Promise<AnswerStore> {
  try {
    return JSON.parse(await readFile(answersFile(task), "utf8")) as AnswerStore;
  } catch {
    return {}; // none yet, or unreadable: answers are only a shortcut
  }
}

async function saveAnswer(
  task: string,
  answers: AnswerStore,
  key: string,
  output: string,
): Promise<void> {
  answers[key] = { output, savedAt: new Date().toISOString() };
  const kept = Object.entries(answers)
    .sort(([, a], [, b]) => b.savedAt.localeCompare(a.savedAt))
    .slice(0, MAX_ANSWERS);
  const file = answersFile(task);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(Object.fromEntries(kept), null, 2));
}

async function writeMetrics(metrics: RunMetrics): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "hotpath-run.json"),
    JSON.stringify(metrics, null, 2),
  );
}

// strict:false — schemas are inferred from recorded results, not hand-written.
// An exact target ("about 3159 characters") made reasoning models count while
// thinking: ERNIE 5.5 spent up to 41k tokens on one replay (docs/BENCHMARK.md).
// Lines are easy to see; the answer must also come without a preamble or fences.
const REPLY_ONLY =
  "Reply with the text only: no introduction, no code fences, no notes about the text.";

/** Non-empty lines in the example: a length hint a model can follow at a glance. */
export function lineCount(text: string): number {
  return Math.max(1, text.split("\n").filter((l) => l.trim() !== "").length);
}

const ajv = new Ajv({ strict: false, allErrors: false });

/** Returns a human reason when the guard fails, else null. */
export function checkToolGuard(
  guard: StepGuard,
  value: unknown,
): string | null {
  if (!guard.schema) return null;
  const validate = ajv.compile(guard.schema);
  if (validate(value)) return null;
  const error = validate.errors?.[0];
  const where = error?.instancePath ? `result${error.instancePath}` : "result";
  return `${where} ${error?.message ?? "does not match the recorded schema"}`;
}

/**
 * Values the output must mention but doesn't. Each entry's paths are resolved
 * against THIS run's results; an entry whose paths no longer resolve is skipped
 * (nothing to check), and for several paths mentioning any one is enough.
 */
/**
 * true / false for a rule, null for a question (the model decides). An empty
 * list, empty text or a missing value counts as empty.
 */
export function checkCondition(
  when: Condition,
  ctx: TemplateContext,
): boolean | null {
  if (when.kind === "ask") return null;
  const value = lookupReference(when.ref, ctx);
  if (when.kind === "equals") return value === when.value;
  if (when.kind === "notEquals") return value !== when.value;
  const empty =
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as object).length === 0);
  return when.kind === "empty" ? empty : !empty;
}

/** The condition in words, for the log. */
export function conditionText(when: Condition): string {
  switch (when.kind) {
    case "nonEmpty":
      return `${when.ref} is empty`;
    case "empty":
      return `${when.ref} is not empty`;
    case "equals":
      return `${when.ref} is not ${JSON.stringify(when.value)}`;
    case "notEquals":
      return `${when.ref} is ${JSON.stringify(when.value)}`;
    case "ask":
      return `the model said no to: ${when.question}`;
  }
}

/** The yes/no question for a step the recordings can't tell apart by a rule. */
export function askPrompt(
  when: Extract<Condition, { kind: "ask" }>,
  ctx: TemplateContext,
): string {
  return [
    renderTemplate(when.prompt, ctx) as string,
    `Given the data above, should the workflow now do this: ${when.question}?`,
    `In an earlier run it did, with this data:\n${when.yes}`,
    `In another earlier run it did not, with this data:\n${when.no}`,
    "Answer with one word: yes or no.",
  ].join("\n\n");
}

/** yes → true, no → false, anything else → null. */
export function parseYesNo(text: string): boolean | null {
  const m = /\b(yes|no)\b/i.exec(text.trim());
  return m ? m[1]!.toLowerCase() === "yes" : null;
}

export function checkGrounding(
  grounding: GroundingEntry[] | undefined,
  ctx: TemplateContext,
  text: string,
): string[] {
  const missing: string[] = [];
  const isValue = (v: unknown): v is string | number =>
    typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
  const note = (v: string | number) => {
    const label = String(v);
    if (!missing.includes(label)) missing.push(label);
  };
  for (const entry of grounding ?? []) {
    // `positions`: as many different items of the list must be mentioned (by any
    // of the recorded fields) as recorded positions still exist today; which
    // items does not matter
    if (entry.positions !== undefined) {
      // the rule that picked the recorded items, applied today: exactly the
      // items it selects must be cited (the count below accepts the wrong ones)
      const unselected = selectionMissing(entry, ctx, text);
      if (unselected !== null) {
        unselected.forEach(note);
        continue;
      }
      const items = new Map<string, boolean>();
      for (const path of entry.paths) {
        for (const ref of expandWildcards(path, ctx)) {
          const v = lookupReference(ref, ctx);
          if (!isValue(v)) continue;
          // the item is the list path plus the index that follows it
          const listPath = path.slice(0, path.lastIndexOf(".*"));
          const dot = ref.indexOf(".", listPath.length + 1);
          const item = dot < 0 ? ref : ref.slice(0, dot);
          items.set(item, (items.get(item) ?? false) || mentions(text, v));
        }
      }
      const need = entry.positions.filter((p) => p < items.size).length;
      const have = [...items.values()].filter(Boolean).length;
      if (have < need) {
        note(
          `${need - have} more of the ${items.size} items in ${entry.paths[0]!.slice(0, entry.paths[0]!.indexOf(".*"))}`,
        );
      }
      continue;
    }
    // `list.*.field`: every current item's field is its own requirement
    const wildcard = entry.paths.find((p) => p.includes(".*"));
    if (wildcard) {
      for (const ref of expandWildcards(wildcard, ctx)) {
        const v = lookupReference(ref, ctx);
        if (isValue(v) && !mentions(text, v)) note(v);
      }
      continue;
    }
    const current = entry.paths
      .map((ref) => lookupReference(ref, ctx))
      .filter(
        (v): v is string | number =>
          typeof v === "string" ||
          (typeof v === "number" && Number.isFinite(v)),
      );
    if (current.length === 0) continue;
    if (current.some((v) => mentions(text, v))) continue;
    const label = String(current[0]);
    if (!missing.includes(label)) missing.push(label);
  }
  return missing;
}

/**
 * `a.*.b.*.c` → one concrete path per item of every list on the way
 * (`a.0.b.0.c`, `a.0.b.1.c`, `a.1.b.0.c`, …), against this run's data.
 */
export function expandWildcards(path: string, ctx: TemplateContext): string[] {
  const at = path.indexOf(".*");
  if (at < 0) return [path];
  const prefix = path.slice(0, at);
  const rest = path.slice(at + 2);
  const list = lookupReference(prefix, ctx);
  if (!Array.isArray(list)) return [];
  return list.flatMap((_, i) => expandWildcards(`${prefix}.${i}${rest}`, ctx));
}

/**
 * Example facts the output repeats although this run's data no longer holds
 * them anywhere (inputs or any step's results): the model copied them from the
 * recorded example. A fact that is still in the data, wherever it sits now, or
 * inside a longer current value, is fine.
 */
export function checkStale(
  facts: Array<string | number> | undefined,
  ctx: TemplateContext,
  text: string,
): string[] {
  if (!facts || facts.length === 0) return [];
  const current: Array<string | number> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === "object") {
      Object.values(node).forEach(visit);
    } else if (
      typeof node === "string" ||
      (typeof node === "number" && Number.isFinite(node))
    ) {
      current.push(node);
    }
  };
  visit(ctx.inputs);
  visit(ctx.steps);
  const stillThere = (fact: string | number) =>
    current.some((v) =>
      typeof v === "number"
        ? v === fact || String(v) === String(fact)
        : mentions(v, fact),
    );
  const stale: string[] = [];
  for (const fact of facts) {
    const label = String(fact);
    if (stale.includes(label) || stillThere(fact)) continue;
    if (mentions(text, fact)) stale.push(label);
  }
  return stale;
}

export function checkLlmGuard(
  guard: StepGuard,
  text: string,
  todayItems = 0,
): string | null {
  if (guard.nonEmpty && text.trim().length === 0) {
    return "llm output is empty (guard nonEmpty)";
  }
  const maxChars =
    guard.maxChars === undefined
      ? undefined
      : scaledMaxChars(guard.maxChars, guard.recordedItems, todayItems);
  if (maxChars !== undefined && text.length > maxChars) {
    return `llm output is ${text.length} chars, exceeds maxChars ${maxChars}`;
  }
  return null;
}

function previewOf(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

// SPEC §5.1 result extraction (same rule as the recorder).
function extractResult(result: unknown): unknown {
  const sc = (result as { structuredContent?: unknown }).structuredContent;
  if (sc !== undefined) return sc;
  const content = (
    result as { content?: Array<{ type: string; text?: string }> }
  ).content;
  const text = content?.find((c) => c.type === "text")?.text;
  if (text !== undefined) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return content ?? null;
}

// Minimal shell-word split (handles double quotes).
function splitCommand(cmd: string): string[] {
  return (cmd.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((w) =>
    w.startsWith('"') && w.endsWith('"') ? w.slice(1, -1) : w,
  );
}

const SELECTIVE_NOTE =
  "The example reports only the items that matter for this task, not every item, " +
  "together with the totals and converted amounts that go with them. Do the same " +
  "with today's data: choose the equivalent items and give the same kinds of figures.";

function isPageRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
