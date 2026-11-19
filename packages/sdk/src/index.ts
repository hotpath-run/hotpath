import { loadWorkflow } from "@hotpathrun/compiler";
import { TraceWriter } from "@hotpathrun/recorder";
import {
  IN_PROCESS_SERVER,
  runTask,
  type AgentRequest,
  type RunMetrics,
  type ToolBackend,
} from "@hotpathrun/runtime";
import {
  assertTaskName,
  toolStepsOf,
  type TraceToolInfo,
} from "@hotpathrun/shared";

// For agents whose tools are functions in their own code (OpenAI or Anthropic
// SDK tool calling, LangChain, the Vercel AI SDK, a hand-written loop), not an
// MCP server. `recordTools` wraps the functions so each call lands in a trace
// the compiler already understands; `runWorkflow` replays the compiled
// workflow by calling the same functions in this process.

/** One tool: what it does and whether calling it changes anything. */
export interface ToolDefinition<A = Record<string, unknown>, R = unknown> {
  description?: string;
  /** JSON schema of the arguments, as given to the model */
  parameters?: Record<string, unknown>;
  /**
   * true for a tool that only reads. Leave it out for anything that sends,
   * writes or deletes: such a step is skipped in a dry run and is never run
   * twice. Unmarked tools are treated as acting, which is the safe mistake.
   */
  readOnly?: boolean;
  execute: (args: A) => Promise<R> | R;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tools = Record<string, ToolDefinition<any, any>>;

export interface RecordOptions {
  task: string;
  /** values that change between runs (a date): they become the workflow's inputs */
  inputs?: Record<string, unknown>;
}

export interface Recording<T extends Tools> {
  /** the same tools; every call is written to the trace */
  tools: T;
  /** closes the trace; call it when the agent is done */
  finish(): Promise<{ traceFile: string }>;
}

function toolInfo(tools: Tools): TraceToolInfo[] {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    inputSchema: tool.parameters ?? { type: "object" },
    annotations: { readOnlyHint: tool.readOnly === true },
  }));
}

/** What a thrown error looks like in the trace (and to the replay's guard). */
function errorValue(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wraps `tools` so that each call is recorded under traces/<task>/. Give the
 * returned `tools` to your agent instead of the originals, run the task once,
 * then `await finish()` and compile: `hotpath compile <task>`.
 */
export function recordTools<T extends Tools>(
  tools: T,
  options: RecordOptions,
): Recording<T> {
  const writer = new TraceWriter(assertTaskName(options.task));
  writer.writeMeta({
    version: 1,
    task: options.task,
    startedAt: new Date().toISOString(),
    server: IN_PROCESS_SERVER,
    cwd: process.cwd(),
    inputs: options.inputs ?? {},
    tools: toolInfo(tools),
  });
  let finished: Promise<{ traceFile: string }> | undefined;

  const wrapped = Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      {
        ...tool,
        execute: async (args: Record<string, unknown>) => {
          const seq = writer.nextSeq();
          const startedAt = new Date().toISOString();
          const start = Date.now();
          const line = (result: unknown, isError: boolean) => {
            if (finished) return; // the agent kept calling after finish()
            writer.write({
              type: "tool_call",
              seq,
              tool: name,
              args: args ?? {},
              // what the model saw: the value as JSON would carry it
              result: result === undefined ? null : toJson(result),
              isError,
              startedAt,
              durationMs: Date.now() - start,
            });
          };
          try {
            const result = await tool.execute(args);
            line(result, false);
            return result;
          } catch (err) {
            line(errorValue(err), true);
            throw err;
          }
        },
      },
    ]),
  ) as T;

  return {
    tools: wrapped,
    finish: () => {
      finished ??= writer
        .writeEnd(new Date().toISOString())
        .then(() => ({ traceFile: writer.file }));
      return finished;
    },
  };
}

/** Dates, undefined fields and class instances become what JSON makes of them. */
function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** The functions as the runtime calls them: a thrown error is a tool error. */
export function toolBackend(tools: Tools): ToolBackend {
  return {
    async call(tool, args) {
      const def = tools[tool];
      if (!def) {
        return {
          value: `no tool named "${tool}" was passed to runWorkflow (tools given: ${Object.keys(tools).join(", ") || "none"})`,
          isError: true,
        };
      }
      try {
        const result = await def.execute(args);
        return {
          value: result === undefined ? null : toJson(result),
          isError: false,
        };
      } catch (err) {
        return { value: errorValue(err), isError: true };
      }
    },
  };
}

export interface RunWorkflowOptions {
  /** the same tools the task was recorded with */
  tools: Tools;
  inputs?: Record<string, string>;
  /** skip tools that are not readOnly and print what they would get */
  dryRun?: boolean;
  /**
   * What to do when the data no longer fits the workflow (drift): run your
   * agent on the task, with tools from `recordTools`, so that a new recording
   * is compiled. Without it, drift is an error (DriftError).
   */
  agent?: (request: AgentRequest) => Promise<void>;
  /** see @hotpathrun/runtime's RunOptions */
  repairMentions?: boolean;
  reuse?: boolean;
  acceptRecompile?: boolean;
}

/**
 * Runs workflows/<task>.json by calling `tools` in this process. Guards, the
 * AI step, dry runs and drift work as they do for MCP servers.
 */
export async function runWorkflow(
  task: string,
  options: RunWorkflowOptions,
): Promise<RunMetrics> {
  const workflow = await loadWorkflow(task);
  const missing = toolsOf(workflow.steps).filter((t) => !(t in options.tools));
  if (missing.length > 0) {
    throw new Error(
      `the workflow for "${task}" calls ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not in the tools passed to runWorkflow — pass the tools the task was recorded with`,
    );
  }
  return runTask(task, {
    inputs: options.inputs ?? {},
    dryRun: options.dryRun,
    noFallback: options.agent === undefined,
    runAgent: options.agent,
    repairMentions: options.repairMentions,
    reuse: options.reuse,
    acceptRecompile: options.acceptRecompile,
    tools: toolBackend(options.tools),
  });
}

function toolsOf(
  steps: Awaited<ReturnType<typeof loadWorkflow>>["steps"],
): string[] {
  return [...new Set(toolStepsOf(steps).map((s) => s.tool))];
}

export { DriftError } from "@hotpathrun/runtime";
export type { AgentRequest, RunMetrics } from "@hotpathrun/runtime";
