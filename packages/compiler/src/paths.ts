import {
  renderTemplate,
  type BranchStep,
  type CaseStep,
  type Condition,
  type ForeachStep,
  type ToolStep,
  type Workflow,
  type WorkflowStep,
} from "@hotpathrun/shared";

import type { Compiled } from "./branches.js";
import { features, learnPathRule, type Feature } from "./rules.js";

// Alternative paths (branching v2). Recordings of one task that took different
// steps (urgent mail → page the on-call; normal → digest; spam → archive) are
// merged into one workflow: the steps they all start with, then a `branch`
// step with a case per distinct path. Each case's rule is learned from what
// the shared steps returned. A path that has no rule becomes a yes/no question
// for the replay model, as for optional steps. No `else`: a run that fits no
// recorded path is a situation never seen, which is drift on purpose.

const MAX_EXAMPLE_CHARS = 1500;

const keyOf = (s: WorkflowStep | CaseStep): string =>
  s.type === "tool"
    ? `tool:${s.tool}`
    : s.type === "foreach"
      ? `each:${s.body[0]!.tool}`
      : s.type;

/** Rename the steps of one case (`s5` → `s5b1`) so ids stay unique in the workflow. */
function renameIds(steps: CaseStep[], suffix: string): CaseStep[] {
  const own = new Set(
    steps.flatMap((s) => [
      s.id,
      ...(s.type === "foreach" ? s.body.map((b) => b.id) : []),
    ]),
  );
  const base = (id: string) => id.split(".")[0]!;
  const newId = (id: string) =>
    `${base(id)}${suffix}${id.slice(base(id).length)}`;
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      if (key === "id" && own.has(value)) return newId(value);
      return value.replace(/steps\.(s\d+)\b/g, (m, id: string) =>
        own.has(id) ? `steps.${id}${suffix}` : m,
      );
    }
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, walk(v, k)]),
      );
    }
    return value;
  };
  return walk(steps) as CaseStep[];
}

function describePath(steps: Array<WorkflowStep | CaseStep>): string {
  const first = steps.find((s) => s.type === "tool" || s.type === "foreach") as
    ToolStep | ForeachStep | undefined;
  if (!first) return "write text";
  const tool = first.type === "foreach" ? first.body[0]! : first;
  const consts = Object.entries(tool.args)
    .filter(([, v]) => typeof v === "string" && !v.includes("{{"))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return `${tool.tool}${consts.length ? ` (${consts.join(", ")})` : ""}`;
}

/**
 * One workflow from recordings whose steps diverge. Null when they do not
 * share a first step to read the discriminator from, or took one path only.
 */
export function mergePaths(
  all: Compiled[],
): { workflow: Workflow; notes: string[] } | null {
  const lists = all.map((c) => c.workflow.steps);
  const shortest = Math.min(...lists.map((l) => l.length));
  let k = 0;
  while (
    k < shortest &&
    keyOf(lists[0]![k]!) !== "llm" &&
    lists.every((l) => keyOf(l[k]!) === keyOf(lists[0]![k]!))
  ) {
    k++;
  }
  if (k === 0) return null;

  // distinct paths, in the order the recordings were made
  const groups: number[][] = [];
  const signatures: string[] = [];
  lists.forEach((l, i) => {
    const sig = l.slice(k).map(keyOf).join(">");
    const at = signatures.indexOf(sig);
    if (at === -1) {
      signatures.push(sig);
      groups.push([i]);
    } else groups[at]!.push(i);
  });
  if (groups.length < 2) return null;

  const newest = all.length - 1;
  const prefixIds = (c: Compiled) =>
    c.workflow.steps.slice(0, k).map((s) => s.id);
  const fieldOf = (c: Compiled, id: string) =>
    c.recorded.has(`${id}.results`) ? "results" : "result";
  const sets = all.map((c) => {
    const map = new Map<string, Feature>();
    for (const id of prefixIds(c)) {
      features(
        c.recorded.get(`${id}.${fieldOf(c, id)}`),
        `steps.${id}.${fieldOf(c, id)}`,
        map,
      );
    }
    return map;
  });

  const prompt = prefixIds(all[newest]!)
    .map(
      (id) =>
        `${id} ${fieldOf(all[newest]!, id)}:\n{{steps.${id}.${fieldOf(all[newest]!, id)}}}`,
    )
    .join("\n\n");
  const dataOf = (i: number) => {
    const c = all[i]!;
    const ctx = {
      inputs: c.trace.meta.inputs,
      steps: {} as Record<string, Record<string, unknown>>,
    };
    for (const id of prefixIds(c)) {
      ctx.steps[id] = {
        [fieldOf(c, id)]: c.recorded.get(`${id}.${fieldOf(c, id)}`),
      };
    }
    return String(renderTemplate(prompt, ctx as never)).slice(
      0,
      MAX_EXAMPLE_CHARS,
    );
  };

  const newestGroup = groups.findIndex((g) => g.includes(newest));
  const cases: BranchStep["cases"] = [];
  for (const [gi, members] of groups.entries()) {
    const rep = members[members.length - 1]!;
    const tail = lists[rep]!.slice(k) as CaseStep[];
    // a path with no steps at all is the older "skip these steps" condition
    if (tail.length === 0) return null;
    const others = groups.flat().filter((i) => !members.includes(i));
    const rule = learnPathRule(
      members.map((i) => sets[i]!),
      others.map((i) => sets[i]!),
    );
    const when: Condition = rule ?? {
      kind: "ask",
      question: describePath(tail),
      prompt,
      yes: dataOf(rep),
      no: dataOf(others[others.length - 1]!),
    };
    cases.push({
      when,
      steps: gi === newestGroup ? tail : renameIds(tail, `b${gi}`),
    });
  }

  const branch: BranchStep = { id: "b1", type: "branch", cases };
  const workflow: Workflow = {
    ...all[newest]!.workflow,
    steps: [...lists[newest]!.slice(0, k), branch],
  };
  return {
    workflow,
    notes: [
      `b1 has ${cases.length} paths: ${cases.map((c) => describePath(c.steps)).join(" | ")}`,
    ],
  };
}
