// What leaves the machine, and nothing else: counts, durations, costs, tool names
// and step kinds. Every field below is picked by name from the workflow or the
// run's metrics; nothing is copied as a whole, so a new field in either (an
// argument, a prompt, a path) cannot leak by being added there.
import { randomUUID } from "node:crypto";

import type { Workflow, WorkflowStep } from "@hotpathrun/shared";

export interface GraphNode {
  id: string;
  kind: "tool" | "llm" | "foreach" | "branch";
  /** a tool's name, or the step kind: never anything the user typed or the model wrote */
  label: string;
}

export interface WorkflowSummary {
  name: string;
  steps: number;
  modelSteps: number;
  toolSteps: number;
  sideEffects: number;
  graph: { nodes: GraphNode[]; edges: Array<{ from: string; to: string }> };
  updatedAt: string;
}

export interface RunSummary {
  id: string;
  workflow: string;
  kind: "replay" | "record";
  ok: boolean;
  fallback: boolean;
  dryRun: boolean;
  durationMs: number;
  llmCalls: number;
  costUsd: number;
  baselineCostUsd?: number;
  baselineDurationMs?: number;
  startedAt: string;
}

/** The parts of the runtime's RunMetrics that are summarised. */
export interface MetricsLike {
  durationMs: number;
  llmCalls: number;
  costUsd: number;
  fallback: boolean;
}

function children(step: WorkflowStep): WorkflowStep[] {
  if (step.type === "foreach") return step.body;
  if (step.type === "branch") {
    return [...step.cases.flatMap((c) => c.steps), ...(step.else ?? [])];
  }
  return [];
}

export function summarizeWorkflow(
  workflow: Workflow,
  updatedAt: Date,
): WorkflowSummary {
  const nodes: GraphNode[] = [];
  const edges: Array<{ from: string; to: string }> = [];
  let modelSteps = 0;
  let toolSteps = 0;
  let sideEffects = 0;

  const walk = (steps: WorkflowStep[], parent?: string): void => {
    let previous: string | undefined;
    for (const step of steps) {
      nodes.push({
        id: step.id,
        kind: step.type,
        label: step.type === "tool" ? step.tool : step.type,
      });
      if (step.type === "tool") {
        toolSteps++;
        if (step.sideEffect) sideEffects++;
      } else if (step.type === "llm") {
        modelSteps++;
      }
      const from = previous ?? parent;
      if (from) edges.push({ from, to: step.id });
      previous = step.id;
      const inner = children(step);
      if (inner.length > 0) walk(inner, step.id);
    }
  };
  walk(workflow.steps);
  return {
    name: workflow.task,
    steps: toolSteps + modelSteps,
    modelSteps,
    toolSteps,
    sideEffects,
    graph: { nodes, edges },
    updatedAt: updatedAt.toISOString(),
  };
}

export function summarizeRun(input: {
  workflow: string;
  kind: "replay" | "record";
  ok: boolean;
  dryRun?: boolean;
  metrics: MetricsLike;
  baseline?: { durationMs: number; costUsd?: number };
  startedAt: Date;
  id?: string;
}): RunSummary {
  const m = input.metrics;
  return {
    id: input.id ?? randomUUID(),
    workflow: input.workflow,
    kind: input.kind,
    ok: input.ok,
    fallback: m.fallback,
    dryRun: input.dryRun === true,
    durationMs: Math.round(m.durationMs),
    llmCalls: m.llmCalls,
    costUsd: m.costUsd,
    ...(input.baseline?.costUsd !== undefined
      ? { baselineCostUsd: input.baseline.costUsd }
      : {}),
    ...(input.baseline
      ? { baselineDurationMs: Math.round(input.baseline.durationMs) }
      : {}),
    startedAt: input.startedAt.toISOString(),
  };
}
