import {
  llmStepsOf,
  whenText,
  type CaseStep,
  type ToolStep,
  type Workflow,
  type WorkflowStep,
} from "@hotpathrun/shared";

// Pure workflow → React Flow graph conversion (SPEC §6 M9); no React here so
// it is unit-testable and usable from node.

export interface StepNodeData extends Record<string, unknown> {
  kind: "tool" | "llm" | "foreach" | "branch" | "case";
  sideEffect: boolean;
  label: string;
  step: WorkflowStep | CaseStep | ToolStep;
}

export interface GraphNode {
  id: string;
  /** "loop" and "branch" are groups drawn around the steps inside them */
  type: "step" | "loop" | "branch";
  position: { x: number; y: number };
  data: StepNodeData;
  /** body steps sit inside their loop's (or branch's) group node */
  parentId?: string;
  extent?: "parent";
  style?: { width: number; height: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

const NODE_WIDTH = 240;
const NODE_HEIGHT = 90;
const COLUMN_GAP = 40;
const ROW_GAP = 40;
const LOOP_PAD = 16;
const LOOP_HEADER = 44;
const CASE_LABEL_HEIGHT = 44;

const STEP_REF = /steps\.([^.}\s"\\]+)/g;

/** ids of earlier steps whose output a step's args/prompt/list/rules reference. */
function referencedSteps(step: WorkflowStep): string[] {
  const source =
    step.type === "tool"
      ? step.args
      : step.type === "llm"
        ? step.prompt
        : step.type === "foreach"
          ? [step.over, step.body.map((b) => b.args)]
          : step;
  const text = JSON.stringify(source);
  return [...new Set([...text.matchAll(STEP_REF)].map((m) => m[1]!))];
}

function laneHeight(steps: CaseStep[]): number {
  return CASE_LABEL_HEIGHT + steps.length * (NODE_HEIGHT + LOOP_PAD);
}

function nodeSize(step: WorkflowStep): { width: number; height: number } {
  if (step.type === "branch") {
    const lanes = [
      ...step.cases.map((c) => c.steps),
      ...(step.else ? [step.else] : []),
    ];
    return {
      width: lanes.length * (NODE_WIDTH + LOOP_PAD) + LOOP_PAD,
      height: LOOP_HEADER + Math.max(...lanes.map(laneHeight)) + LOOP_PAD / 2,
    };
  }
  if (step.type !== "foreach") {
    return { width: NODE_WIDTH, height: NODE_HEIGHT };
  }
  return {
    width: NODE_WIDTH + 2 * LOOP_PAD,
    height:
      LOOP_HEADER + step.body.length * (NODE_HEIGHT + LOOP_PAD) + LOOP_PAD / 2,
  };
}

function stepData(step: WorkflowStep | CaseStep | ToolStep): StepNodeData {
  if (step.type === "tool") {
    return {
      kind: "tool",
      sideEffect: step.sideEffect,
      label: step.tool,
      step,
    };
  }
  if (step.type === "llm") {
    return {
      kind: "llm",
      sideEffect: false,
      label: `llm (${step.model})`,
      step,
    };
  }
  if (step.type === "branch") {
    return {
      kind: "branch",
      sideEffect: allSteps({ steps: [step] }).some(
        (s) => s.type === "tool" && s.sideEffect,
      ),
      label: `branch (${step.cases.length} paths)`,
      step,
    };
  }
  return {
    kind: "foreach",
    sideEffect: step.body.some((b) => b.sideEffect),
    label: `for each ${step.as}`,
    step,
  };
}

export function workflowToGraph(workflow: Workflow): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const known = new Set(workflow.steps.map((s) => s.id));
  const edges: GraphEdge[] = [];
  const depth = new Map<string, number>();

  for (const step of workflow.steps) {
    const deps = referencedSteps(step).filter(
      (id) => known.has(id) && id !== step.id,
    );
    for (const source of deps) {
      edges.push({ id: `${source}->${step.id}`, source, target: step.id });
    }
    depth.set(
      step.id,
      deps.length === 0
        ? 0
        : Math.max(...deps.map((d) => depth.get(d) ?? 0)) + 1,
    );
  }

  // a row is as tall as its tallest node (loops and branches are taller)
  const rowHeight = new Map<number, number>();
  for (const step of workflow.steps) {
    const level = depth.get(step.id) ?? 0;
    rowHeight.set(
      level,
      Math.max(rowHeight.get(level) ?? 0, nodeSize(step).height),
    );
  }
  const rowY = (level: number) => {
    let y = 0;
    for (let l = 0; l < level; l++) {
      y += (rowHeight.get(l) ?? NODE_HEIGHT) + ROW_GAP;
    }
    return y;
  };

  const countAtDepth = new Map<number, number>();
  const nodes: GraphNode[] = [];
  for (const step of workflow.steps) {
    const level = depth.get(step.id) ?? 0;
    const column = countAtDepth.get(level) ?? 0;
    countAtDepth.set(level, column + 1);
    const position = {
      x: column * (NODE_WIDTH + 2 * LOOP_PAD + COLUMN_GAP),
      y: rowY(level),
    };
    if (step.type === "branch") {
      // React Flow needs a parent before its children; one lane per path
      nodes.push({
        id: step.id,
        type: "branch",
        position,
        data: stepData(step),
        style: nodeSize(step),
      });
      const lanes: Array<{ label: string; steps: CaseStep[] }> = [
        ...step.cases.map((c) => ({
          label: `if ${whenText(c.when)}`,
          steps: c.steps,
        })),
        ...(step.else ? [{ label: "otherwise", steps: step.else }] : []),
      ];
      lanes.forEach((lane, i) => {
        const x = LOOP_PAD + i * (NODE_WIDTH + LOOP_PAD);
        nodes.push({
          id: `${step.id}:case${i}`,
          type: "step",
          position: { x, y: LOOP_HEADER },
          data: {
            kind: "case",
            sideEffect: false,
            label: lane.label,
            step: step,
          },
          parentId: step.id,
          extent: "parent",
        });
        lane.steps.forEach((inner, j) => {
          nodes.push({
            id: inner.id,
            type: "step",
            position: {
              x,
              y: LOOP_HEADER + CASE_LABEL_HEIGHT + j * (NODE_HEIGHT + LOOP_PAD),
            },
            data: stepData(inner),
            parentId: step.id,
            extent: "parent",
          });
        });
      });
      continue;
    }
    if (step.type !== "foreach") {
      nodes.push({ id: step.id, type: "step", position, data: stepData(step) });
      continue;
    }
    // React Flow needs a parent before its children
    nodes.push({
      id: step.id,
      type: "loop",
      position,
      data: stepData(step),
      style: nodeSize(step),
    });
    step.body.forEach((body, i) => {
      nodes.push({
        id: body.id,
        type: "step",
        position: {
          x: LOOP_PAD,
          y: LOOP_HEADER + i * (NODE_HEIGHT + LOOP_PAD),
        },
        data: stepData(body),
        parentId: step.id,
        extent: "parent",
      });
    });
  }

  return { nodes, edges };
}

/** Header text: "5 steps · 1 use AI" (plus loops and branches when there are some). */
export function summarize(workflow: Workflow): string {
  const ai = llmStepsOf(workflow.steps).length;
  const count = (type: string, noun: string) => {
    const n = workflow.steps.filter((s) => s.type === type).length;
    return n > 0 ? ` · ${n} ${noun}${n === 1 ? "" : "s"}` : "";
  };
  return `${workflow.steps.length} steps · ${ai} use AI${count("foreach", "loop")}${count("branch", "branch")}`;
}

/** Every step, loop bodies and the steps inside branches included (for selection by id). */
export function allSteps(
  workflow: Pick<Workflow, "steps">,
): Array<WorkflowStep | CaseStep | ToolStep> {
  return workflow.steps.flatMap<WorkflowStep | CaseStep | ToolStep>((s) =>
    s.type === "foreach"
      ? [s, ...s.body]
      : s.type === "branch"
        ? [
            s,
            ...allSteps({
              steps: [...s.cases.flatMap((c) => c.steps), ...(s.else ?? [])],
            }),
          ]
        : [s],
  );
}
