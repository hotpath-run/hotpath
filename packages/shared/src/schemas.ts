import { z } from "zod";

import { calculationSchema } from "./calc.js";
import { selectionSchema } from "./selection.js";
import { taskNameProblem } from "./task-name.js";

/** A task name is used as a file name: one that names a path is refused. */
const taskName = z.string().superRefine((value, ctx) => {
  const problem = taskNameProblem(value);
  if (problem) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `invalid task name: ${problem}`,
    });
  }
});

// Trace (SPEC §5.1) — one JSON object per line: meta, tool_call*, end.
export const traceToolInfoSchema = z.object({
  name: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.record(z.string(), z.unknown()).optional(),
});
export type TraceToolInfo = z.infer<typeof traceToolInfoSchema>;

export const traceMetaSchema = z.object({
  type: z.literal("meta"),
  version: z.literal(1),
  task: taskName,
  startedAt: z.string(),
  server: z.string(),
  /** the server command as an argv array (paths with spaces stay intact) */
  serverArgv: z.array(z.string()).optional(),
  /** working directory the server was started in */
  cwd: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()),
  tools: z.array(traceToolInfoSchema),
});
export type TraceMeta = z.infer<typeof traceMetaSchema>;

export const traceToolCallSchema = z.object({
  type: z.literal("tool_call"),
  seq: z.number().int().positive(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  result: z.unknown(),
  isError: z.boolean(),
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
});
export type TraceToolCall = z.infer<typeof traceToolCallSchema>;

export const traceEndSchema = z.object({
  type: z.literal("end"),
  endedAt: z.string(),
  toolCalls: z.number().int().nonnegative(),
});
export type TraceEnd = z.infer<typeof traceEndSchema>;

export const traceLineSchema = z.discriminatedUnion("type", [
  traceMetaSchema,
  traceToolCallSchema,
  traceEndSchema,
]);
export type TraceLine = z.infer<typeof traceLineSchema>;

// Workflow (SPEC §5.2) — compiled from a trace by packages/compiler.
/**
 * llm steps: a value from an earlier step's result that the recorded example
 * output mentions. `paths` are the template references (e.g.
 * "steps.s1.result.emails.0.subject") that held that value in the recording;
 * at run time the output must mention what those paths hold *now*.
 */
export const groundingEntrySchema = z.object({
  /**
   * With `positions`, `paths` are wildcard paths over a list: the recording
   * cited the items at these positions (by any of the fields). The output must
   * cite as many different items as of those positions still exist today, not
   * necessarily the same ones (see relaxPositional in the compiler).
   */
  positions: z.array(z.number().int().min(0)).min(1).optional(),
  /**
   * With `positions`: the rule that selected those items in the recording
   * (not in the ledger, currency = USD…). When it can be applied to the run's
   * data, the output must cite exactly the items it selects today, instead of
   * any `positions.length` items.
   */
  select: selectionSchema.optional(),
  value: z.union([z.string(), z.number()]),
  paths: z.array(z.string()).min(1),
});
export type GroundingEntry = z.infer<typeof groundingEntrySchema>;

export const stepGuardSchema = z.object({
  /** tool steps: JSON schema inferred from the recorded result */
  schema: z.record(z.string(), z.unknown()).optional(),
  /** llm steps */
  nonEmpty: z.boolean().optional(),
  maxChars: z.number().int().positive().optional(),
  /** llm steps: list items in the data the recording had; maxChars grows with today's count */
  recordedItems: z.number().int().positive().optional(),
  /** llm steps: values from earlier results the output must mention */
  grounding: z.array(groundingEntrySchema).optional(),
  /**
   * llm steps: every value from earlier results the recorded example
   * mentions. The output must not repeat one that is no longer in the run's
   * data: that is a fact copied from the example.
   */
  exampleFacts: z.array(z.union([z.string(), z.number()])).optional(),
});
export type StepGuard = z.infer<typeof stepGuardSchema>;

/**
 * When a step runs. Learned from several recordings of the same task: a step
 * only some recordings made gets the rule that tells those runs apart, or,
 * when no simple rule does, a yes/no question for the replay model.
 * `ref` is a template reference without braces (`steps.s1.result.emails`).
 */
export const conditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("nonEmpty"), ref: z.string() }),
  z.object({ kind: z.literal("empty"), ref: z.string() }),
  z.object({
    kind: z.literal("equals"),
    ref: z.string(),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({
    kind: z.literal("notEquals"),
    ref: z.string(),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({
    kind: z.literal("ask"),
    /** what would run, in words ("send_message (to=\"me\")") */
    question: z.string(),
    /** this run's data (templates) */
    prompt: z.string(),
    /** data from a recording where the step ran, and one where it did not */
    yes: z.string(),
    no: z.string(),
  }),
]);
export type Condition = z.infer<typeof conditionSchema>;

export const toolStepSchema = z.object({
  id: z.string(),
  type: z.literal("tool"),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  sideEffect: z.boolean(),
  /** an action a rerun may do again (it dedupes itself): the crash journal does not hold it back */
  repeatable: z.boolean().optional(),
  guard: stepGuardSchema,
  when: conditionSchema.optional(),
  /** read-only: keep asking with `arg` set to the result's `next` field until it is empty; the result is all pages merged */
  paginate: z
    .object({
      arg: z.string(),
      next: z.string(),
      maxPages: z.number().int().positive().optional(),
    })
    .optional(),
});
export type ToolStep = z.infer<typeof toolStepSchema>;

export const llmStepSchema = z.object({
  id: z.string(),
  type: z.literal("llm"),
  model: z.string(),
  prompt: z.string(),
  example: z.string(),
  /**
   * answerKey(example, prompt as rendered on the recorded data). A run whose
   * data renders to the same key reuses the example instead of asking a model.
   */
  inputKey: z.string().optional(),
  /**
   * The recorded text covers only some of the items of a list the step reads
   * (and the owner did not require all): it is a selection (the unmatched
   * lines of a reconciliation), so the model is told to select the same way
   * instead of "cover every item".
   */
  selective: z.boolean().optional(),
  /**
   * Lines of the recorded text with a figure the agent calculated (a total, a
   * converted amount) written as <calculated>. The replay prompt asks for the
   * same kinds of lines, calculated from the run's data.
   */
  derived: z.array(z.string()).optional(),
  /**
   * How the agent got its calculated figures (a sum over the selected items,
   * converted to the report's currency…), learned from the recording. Code
   * computes them on each run's data, the model is given the results, and the
   * output must state them (see calc.ts).
   */
  calculations: z.array(calculationSchema).optional(),
  /**
   * The example with its list rows taken out (`skeleton`, one marker line per
   * list) and how one row is written (`rows`). At run time code writes the
   * rows from the data and the model writes only the rest.
   */
  layout: z
    .object({
      skeleton: z.string(),
      rows: z
        .array(
          z.object({
            marker: z.string(),
            over: z.string(),
            template: z.string(),
          }),
        )
        .min(1),
    })
    .optional(),
  guard: stepGuardSchema,
  when: conditionSchema.optional(),
});
export type LlmStep = z.infer<typeof llmStepSchema>;

/**
 * Runs `body` once per item of the list `over` resolves to. Inside the body,
 * `{{<as>.<path>}}` is the current item; afterwards `{{steps.<id>.results}}`
 * is the list of per-item results.
 */
export const foreachStepSchema = z.object({
  id: z.string(),
  type: z.literal("foreach"),
  over: z.string(),
  as: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .refine((v) => v !== "inputs" && v !== "steps", "reserved name"),
  body: z.array(toolStepSchema).min(1),
  maxItems: z.number().int().positive(),
  when: conditionSchema.optional(),
});
export type ForeachStep = z.infer<typeof foreachStepSchema>;

export const DEFAULT_MAX_ITEMS = 50;

/** What a branch case may run: not another branch (kept one level deep). */
export const caseStepSchema = z.discriminatedUnion("type", [
  toolStepSchema,
  llmStepSchema,
  foreachStepSchema,
]);
export type CaseStep = z.infer<typeof caseStepSchema>;

/**
 * Different recordings of one task took different steps (urgent mail → page
 * the on-call, normal → add to the digest). The runtime runs the steps of the
 * first case whose `when` is true, else `else`. When nothing matches and
 * there is no `else`, the situation was never recorded: that is drift, so the
 * agent runs once and the next compile learns the new path.
 */
export const branchStepSchema = z.object({
  id: z.string(),
  type: z.literal("branch"),
  cases: z
    .array(
      z.object({
        /** one line for people ("urgent mail"), shown by `hotpath show` */
        label: z.string().optional(),
        when: conditionSchema,
        steps: z.array(caseStepSchema).min(1),
      }),
    )
    .min(1),
  else: z.array(caseStepSchema).min(1).optional(),
  when: conditionSchema.optional(),
});
export type BranchStep = z.infer<typeof branchStepSchema>;

export const workflowStepSchema = z.discriminatedUnion("type", [
  toolStepSchema,
  llmStepSchema,
  foreachStepSchema,
  branchStepSchema,
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowInputSchema = z.object({
  type: z.string(),
  example: z.unknown(),
});
export type WorkflowInput = z.infer<typeof workflowInputSchema>;

/**
 * A recorded call the compiler left out because it failed (isError) —
 * "retried" if the same tool later succeeded, "failed" if it never did.
 */
export const droppedCallSchema = z.object({
  /** tool_call.seq in the trace */
  seq: z.number().int().positive(),
  /** line number in the trace file (meta is line 1) */
  line: z.number().int().positive(),
  tool: z.string(),
  reason: z.enum(["failed", "retried"]),
  /** start of the error text the tool returned */
  error: z.string().optional(),
});
export type DroppedCall = z.infer<typeof droppedCallSchema>;

export const workflowSchema = z.object({
  version: z.literal(1),
  task: taskName,
  compiledFrom: z.string(),
  server: z.string(),
  serverArgv: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  inputs: z.record(z.string(), workflowInputSchema),
  steps: z.array(workflowStepSchema),
  /**
   * Paths the user made required for every item (`hotpath compile --require`),
   * e.g. "steps.s1.result.emails.*.subject". Kept here so a recompile after a
   * fallback applies them again.
   */
  require: z.array(z.string()).optional(),
  /** failed/retried calls from the trace that did not become steps */
  droppedCalls: z.array(droppedCallSchema).optional(),
  /** what the recorded agent run took: the reference for "saved" estimates */
  baseline: z
    .object({
      durationMs: z.number().nonnegative(),
      /** only when the agent reported it (out/agent-run.json during the trace) */
      costUsd: z.number().nonnegative().optional(),
    })
    .optional(),
});
export type Workflow = z.infer<typeof workflowSchema>;
