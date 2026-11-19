import {
  renderTemplate,
  type Condition,
  type GroundingEntry,
  type LlmStep,
  type TraceFile,
  type Workflow,
  type WorkflowStep,
} from "@hotpathrun/shared";

import { compileTraceDetailed, type RecordedResult } from "./compiler.js";
import { mergePaths } from "./paths.js";
import { features, learnRule, type Feature } from "./rules.js";

export { learnRule };

// Branch learning (several recordings of one task → one workflow). A single
// recording is one path; when another recording skipped some steps (no new
// emails → nothing sent), those steps get a condition that tells the runs
// apart. Only "one recording made extra steps" is merged; recordings that
// took different steps altogether are reported, and the newest one is used.

/** How many recent recordings of a task are compared. */
export const MAX_RECORDINGS = 5;

export interface Compiled {
  trace: TraceFile;
  workflow: Workflow;
  /** each step's recorded result, as the compiler returned it */
  results: RecordedResult[];
  recorded: Map<string, unknown>;
  /** non-llm steps in order: tool, or "tool*" for a loop */
  sig: string[];
  /** the step id behind each sig entry */
  ids: string[];
}

export interface BranchResult {
  workflow: Workflow;
  /** which recordings were compared (index into the input), newest last */
  used: number[];
  warnings: string[];
  /** what was learned beyond the newest recording, in words */
  notes: string[];
  /** what each step of `workflow` returned in the recording it comes from */
  recorded: RecordedResult[];
}

function compile(trace: TraceFile, compiledFrom: string): Compiled {
  const { workflow, recorded } = compileTraceDetailed(trace, compiledFrom);
  const steps = workflow.steps.filter((s) => s.type !== "llm");
  return {
    trace,
    workflow,
    results: recorded,
    recorded: new Map(
      recorded.map((r: RecordedResult) => [`${r.id}.${r.field}`, r.result]),
    ),
    sig: steps.map((s) =>
      s.type === "foreach"
        ? `${s.body[0]!.tool}*`
        : (s as { tool: string }).tool,
    ),
    ids: steps.map((s) => s.id),
  };
}

/** Indices in `sup` that `sub` occupies, in order; null when it isn't a subsequence. */
export function embed(sub: string[], sup: string[]): number[] | null {
  const at: number[] = [];
  let j = 0;
  for (const item of sub) {
    while (j < sup.length && sup[j] !== item) j++;
    if (j === sup.length) return null;
    at.push(j++);
  }
  return at;
}

/** Every key path in a value (arrays merged), so two results can be compared by shape. */
export function shapeOf(
  value: unknown,
  prefix = "",
  out = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) shapeOf(item, `${prefix}[]`, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(`${prefix}.${k}`);
      shapeOf(v, `${prefix}.${k}`, out);
    }
  }
  return out;
}

/**
 * True when every tool both recordings used answered in a compatible shape:
 * one result's key paths contain the other's (an empty list has fewer paths,
 * not different ones). A recording from before a tool changed (a renamed
 * field) must not be merged: its steps would bring back the old format.
 */
export function sameShapes(a: TraceFile, b: TraceFile): boolean {
  const first = (t: TraceFile) => {
    const map = new Map<string, Set<string>>();
    for (const c of t.calls) {
      if (c.isError || map.has(c.tool)) continue;
      map.set(c.tool, shapeOf(c.result));
    }
    return map;
  };
  const within = (x: Set<string>, y: Set<string>) =>
    [...x].every((k) => y.has(k));
  const sa = first(a);
  const sb = first(b);
  for (const [tool, shape] of sa) {
    const other = sb.get(tool);
    if (other && !within(shape, other) && !within(other, shape)) return false;
  }
  return true;
}

const MAX_EXAMPLE_CHARS = 1500;

function describe(step: WorkflowStep): string {
  if (step.type === "llm") return "write text";
  if (step.type === "branch") return "choose a path";
  const tool = step.type === "foreach" ? step.body[0]! : step;
  const consts = Object.entries(tool.args)
    .filter(([, v]) => typeof v === "string" && !v.includes("{{"))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return `${tool.tool}${consts.length ? ` (${consts.join(", ")})` : ""}${step.type === "foreach" ? " for each item" : ""}`;
}

/** Steps whose args read the output of `ids` (the llm step that writes a message). */
function feeders(workflow: Workflow, toolIds: Set<string>): string[] {
  const out: string[] = [];
  for (const step of workflow.steps) {
    if (step.type !== "tool" || !toolIds.has(step.id)) continue;
    for (const v of Object.values(step.args)) {
      const m =
        typeof v === "string"
          ? /^\{\{steps\.([^.}]+)\.output\}\}$/.exec(v)
          : null;
      if (m) out.push(m[1]!);
    }
  }
  return out;
}

export function compileTraces(
  traces: TraceFile[],
  compiledFrom: string,
): BranchResult {
  if (traces.length === 0) throw new Error("no recordings to compile");
  const newestTrace = traces[traces.length - 1]!;
  // newest last; older recordings with another data shape are left out
  const used = traces
    .map((t, i) => ({ t, i }))
    .filter(({ t }, i) => i === traces.length - 1 || sameShapes(t, newestTrace))
    .slice(-MAX_RECORDINGS);
  const warnings: string[] = [];
  const all = used.map(({ t }) => compile(t, compiledFrom));
  const newest = all[all.length - 1]!;
  const indices = used.map((u) => u.i);
  const finish = (base: Compiled, workflow: Workflow): BranchResult => {
    const learned = learnCoverage(base, workflow, all);
    return {
      workflow: learned.workflow,
      used: indices,
      warnings,
      notes: learned.notes,
      recorded: base.results,
    };
  };
  const plain = (): BranchResult => finish(newest, newest.workflow);
  if (all.length === 1 || all.every((c) => c.sig.join() === newest.sig.join()))
    return plain();

  // the recording that made every step any other one made (prefer the newest)
  const base = [...all]
    .reverse()
    .find((c) => all.every((o) => embed(o.sig, c.sig)));
  if (!base) {
    const merged = mergePaths(all);
    if (merged) {
      return {
        workflow: { ...merged.workflow, compiledFrom },
        used: indices,
        warnings,
        notes: merged.notes,
        recorded: newest.results,
      };
    }
    warnings.push(
      "the recordings took different steps, not just extra ones; compiled the newest only " +
        `(${all.map((c) => c.sig.join(" → ")).join("  |  ")})`,
    );
    return plain();
  }
  const placed = all.map((c) => embed(c.sig, base.sig)!);
  const present = (k: number, i: number) => placed[k]!.includes(i);
  const always = base.sig.map((_, i) => all.every((_, k) => present(k, i)));

  // what each recording's always-present steps returned, under the base's ids
  const featureSets = all.map((c, k) => {
    const map = new Map<string, Feature>();
    for (const [name, value] of Object.entries(c.trace.meta.inputs)) {
      features(value, `inputs.${name}`, map);
    }
    placed[k]!.forEach((baseIx, own) => {
      if (!always[baseIx]) return;
      const id = c.ids[own]!;
      const field = c.recorded.has(`${id}.results`) ? "results" : "result";
      features(
        c.recorded.get(`${id}.${field}`),
        `steps.${base.ids[baseIx]}.${field}`,
        map,
      );
    });
    return map;
  });

  // optional steps in a row that the same recordings made share one condition
  const conditions = new Map<string, Condition>();
  let i = 0;
  while (i < base.sig.length) {
    if (always[i]) {
      i++;
      continue;
    }
    const pattern = all.map((_, k) => present(k, i)).join();
    let end = i;
    while (
      end + 1 < base.sig.length &&
      !always[end + 1] &&
      all.map((_, k) => present(k, end + 1)).join() === pattern
    )
      end++;
    const yesK = all.map((_, k) => k).filter((k) => present(k, i));
    const noK = all.map((_, k) => k).filter((k) => !present(k, i));
    const before = (k: number) => {
      const m = new Map<string, Feature>();
      for (const [ref, f] of featureSets[k]!) {
        const stepId = /^steps\.([^.]+)\./.exec(ref)?.[1];
        const baseIx = stepId ? base.ids.indexOf(stepId) : -1;
        if (!stepId || baseIx < i) m.set(ref, f);
      }
      return m;
    };
    const groupIds = base.ids.slice(i, end + 1);
    const rule = learnRule(yesK.map(before), noK.map(before));
    const condition =
      rule ?? askCondition(base, all, i, groupIds, yesK[0]!, noK[0]!, always);
    for (const id of groupIds) conditions.set(id, condition);
    i = end + 1;
  }
  for (const id of feeders(base.workflow, new Set(conditions.keys()))) {
    const fed = base.workflow.steps.find(
      (s) =>
        s.type === "tool" &&
        Object.values(s.args).includes(`{{steps.${id}.output}}`),
    );
    if (fed) conditions.set(id, conditions.get(fed.id)!);
  }
  const steps = base.workflow.steps.map((s) =>
    conditions.has(s.id) ? { ...s, when: conditions.get(s.id)! } : s,
  );
  return finish(base, { ...base.workflow, steps, compiledFrom });
}

/** The step ids of `own` under the ids `base` uses (null: not the same steps). */
function idMap(own: Compiled, base: Compiled): Map<string, string> | null {
  const placed = embed(own.sig, base.sig);
  if (!placed) return null;
  const map = new Map<string, string>();
  placed.forEach((baseIx, ownIx) =>
    map.set(own.ids[ownIx]!, base.ids[baseIx]!),
  );
  // an AI step is the one that writes the same action's text
  const consumer = (w: Workflow, llmId: string) =>
    w.steps.find(
      (s) =>
        s.type === "tool" &&
        Object.values(s.args).includes(`{{steps.${llmId}.output}}`),
    )?.id;
  for (const step of own.workflow.steps) {
    if (step.type !== "llm") continue;
    const fed = consumer(own.workflow, step.id);
    const baseFed = fed ? map.get(fed) : undefined;
    const baseLlm = base.workflow.steps.find(
      (s) => s.type === "llm" && consumer(base.workflow, s.id) === baseFed,
    );
    if (baseFed && baseLlm) map.set(step.id, baseLlm.id);
  }
  return map;
}

/**
 * A field one recording's message mentioned for most items of a list is
 * required for every item (see generalizeListFields). When another recording
 * of the same task learned such a field and the base did not (its agent left
 * that list out that day), the base's AI step gets the requirement too: what
 * the task's message must cover does not depend on which run was recorded last.
 */
function learnCoverage(
  base: Compiled,
  workflow: Workflow,
  all: Compiled[],
): { workflow: Workflow; notes: string[] } {
  const extra = new Map<string, GroundingEntry[]>();
  const notes: string[] = [];
  for (const other of all) {
    if (other === base) continue;
    const ids = idMap(other, base);
    if (!ids) continue;
    for (const step of other.workflow.steps) {
      if (step.type !== "llm") continue;
      const target = ids.get(step.id);
      const baseStep = workflow.steps.find(
        (s): s is LlmStep => s.type === "llm" && s.id === target,
      );
      if (!baseStep) continue;
      for (const entry of step.guard.grounding ?? []) {
        // "some items" (positions) is not a requirement for every item
        if (entry.positions !== undefined) continue;
        // a whole list field (`emails.*.subject`) or a plain value (the
        // weather summary). One item of a list (`emails.0.subject`) is that
        // day's item and teaches nothing about another day.
        const path = entry.paths.length === 1 ? entry.paths[0]! : "";
        const oneItem = path
          .split(".")
          .slice(3)
          .some((p) => /^\d+$/.test(p));
        if (path === "" || oneItem) continue;
        const parts = path.split(".");
        const sourceId = ids.get(parts[1]!);
        if (!sourceId) continue;
        const mapped = [parts[0], sourceId, ...parts.slice(2)].join(".");
        const have = [
          ...(baseStep.guard.grounding ?? []),
          ...(extra.get(baseStep.id) ?? []),
        ];
        if (have.some((g) => g.paths.includes(mapped))) continue;
        extra.set(baseStep.id, [
          ...(extra.get(baseStep.id) ?? []),
          { value: entry.value, paths: [mapped] },
        ]);
        notes.push(
          `${baseStep.id} must mention ${mapped}: an earlier recording covered it`,
        );
      }
    }
  }
  if (extra.size === 0) return { workflow, notes };
  return {
    workflow: {
      ...workflow,
      steps: workflow.steps.map((s) =>
        s.type === "llm" && extra.has(s.id)
          ? {
              ...s,
              guard: {
                ...s.guard,
                grounding: [...(s.guard.grounding ?? []), ...extra.get(s.id)!],
              },
            }
          : s,
      ),
    },
    notes,
  };
}

function askCondition(
  base: Compiled,
  all: Compiled[],
  start: number,
  groupIds: string[],
  yesK: number,
  noK: number,
  always: boolean[],
): Condition {
  // the data a run has before the step: always-present read-only results
  const refs = base.ids
    .slice(0, start)
    .filter((_, ix) => always[ix])
    .map((id) => {
      const field = base.recorded.has(`${id}.results`) ? "results" : "result";
      return { id, field, tool: base.sig[base.ids.indexOf(id)]! };
    });
  const prompt = refs
    .map((r) => `${r.id} ${r.tool} ${r.field}:\n{{steps.${r.id}.${r.field}}}`)
    .join("\n\n");
  const dataOf = (k: number) => {
    const c = all[k]!;
    const placedK = embed(c.sig, base.sig)!;
    const ctx = {
      inputs: c.trace.meta.inputs,
      steps: {} as Record<string, Record<string, unknown>>,
    };
    placedK.forEach((baseIx, own) => {
      const id = c.ids[own]!;
      const field = c.recorded.has(`${id}.results`) ? "results" : "result";
      ctx.steps[base.ids[baseIx]!] = {
        [field]: c.recorded.get(`${id}.${field}`),
      };
    });
    return String(renderTemplate(prompt, ctx as never)).slice(
      0,
      MAX_EXAMPLE_CHARS,
    );
  };
  const first = base.workflow.steps.find((s) => s.id === groupIds[0])!;
  return {
    kind: "ask",
    question: describe(first),
    prompt,
    yes: dataOf(yesK),
    no: dataOf(noK),
  };
}
