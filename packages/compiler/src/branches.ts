import {
  countItems,
  numbersInText,
  renderTemplate,
  type BranchStep,
  type CaseStep,
  type Condition,
  type GroundingEntry,
  type LlmStep,
  type TraceFile,
  type Workflow,
  type WorkflowStep,
} from "@hotpathrun/shared";

import {
  compileTraceDetailed,
  textArgKey,
  type CompileHints,
  type ItemSamples,
  type ListSource,
  inferCommonSchema,
  type RecordedResult,
} from "./compiler.js";
import { mergePaths, renameIds, renameRecorded } from "./paths.js";
import {
  features,
  givenInputs,
  learnInputRule,
  learnItemRule,
  learnItemThresholdRule,
  learnNumberRule,
  learnRule,
  varyingInputs,
  type Feature,
} from "./rules.js";

export { learnItemThresholdRule, learnNumberRule, learnRule };

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
  /** sig, with each step's short constant arguments: tells get_weather(Oslo) from get_weather(Paris) */
  keys: string[];
  /** per sig entry: the step changes something outside (its order matters) */
  effects: boolean[];
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

function compile(
  trace: TraceFile,
  compiledFrom: string,
  hints: CompileHints = {},
): Compiled {
  const { workflow, recorded } = compileTraceDetailed(
    trace,
    compiledFrom,
    hints,
  );
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
    effects: steps.map((s) =>
      s.type === "foreach"
        ? s.body[0]!.sideEffect
        : (s as { sideEffect?: boolean }).sideEffect === true,
    ),
    keys: steps.map((s) => {
      const tool = s.type === "foreach" ? s.body[0]! : s;
      const consts = Object.entries(
        (tool as { args: Record<string, unknown> }).args,
      )
        .filter(
          ([, v]) =>
            typeof v === "string" && !v.includes("{{") && v.length < 40,
        )
        .map(([k, v]) => `${k}=${String(v)}`);
      return `${(tool as { tool: string }).tool}${s.type === "foreach" ? "*" : ""}(${consts.join(",")})`;
    }),
  };
}

/**
 * `c` without the reads no other recording made: they change nothing, so they
 * are no reason to call two recordings different paths. Only the view used to
 * compare is trimmed; the workflow keeps every step.
 */
function withoutNoise(c: Compiled, all: Compiled[]): Compiled {
  const keep = c.keys.map(
    (key, i) =>
      c.effects[i] || all.some((o) => o !== c && o.keys.includes(key)),
  );
  const pick = <T>(xs: T[]) => xs.filter((_, i) => keep[i]);
  return {
    ...c,
    sig: pick(c.sig),
    ids: pick(c.ids),
    keys: pick(c.keys),
    effects: pick(c.effects),
  };
}

/**
 * Where `own`'s steps sit among `base`'s: by tool, and between steps of one
 * tool by constant arguments (a noise read of Oslo's weather must not take the
 * place of the read of Paris's). When no placement matches every constant, the
 * one with the fewest differences is used: a text that differs between
 * recordings is the same step.
 */
export function align(own: Compiled, base: Compiled): number[] | null {
  const ordered = embedClosest(own, base);
  const exact = ordered?.every((j, i) => own.keys[i] === base.keys[j]);
  return exact ? ordered! : (matchReordered(own, base) ?? ordered);
}

/**
 * Like embed over the tools, but between steps of one tool it prefers the one
 * with the same constant arguments: the fewest mismatches wins, ties go to
 * the earliest placement. Null when the tools are not a subsequence.
 */
export function embedClosest(
  sub: { sig: string[]; keys: string[] },
  sup: { sig: string[]; keys: string[] },
): number[] | null {
  const n = sub.sig.length;
  const m = sup.sig.length;
  // best[i][j]: fewest mismatches placing sub[i..] into sup[j..]
  const best: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(Infinity),
  );
  for (let j = 0; j <= m; j++) best[n]![j] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const skip = best[i]![j + 1]!;
      const take =
        sub.sig[i] === sup.sig[j]
          ? best[i + 1]![j + 1]! + (sub.keys[i] === sup.keys[j] ? 0 : 1)
          : Infinity;
      best[i]![j] = Math.min(skip, take);
    }
  }
  if (!Number.isFinite(best[0]![0]!)) return null;
  const at: number[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    // earliest j that still reaches the optimum for this step
    while (true) {
      const take =
        sub.sig[i] === sup.sig[j]
          ? best[i + 1]![j + 1]! + (sub.keys[i] === sup.keys[j] ? 0 : 1)
          : Infinity;
      if (take === best[i]![j]) break;
      j++;
    }
    at.push(j++);
  }
  return at;
}

/**
 * Two agents read the same things in another order (weather before the stats,
 * or after): every step of `own` has an identical step in `base`, and the
 * steps that change something keep their order. Null otherwise.
 */
function matchReordered(own: Compiled, base: Compiled): number[] | null {
  const used = new Set<number>();
  const at: number[] = [];
  for (const key of own.keys) {
    const j = base.keys.findIndex((k, ix) => k === key && !used.has(ix));
    if (j === -1) return null;
    used.add(j);
    at.push(j);
  }
  const acting = at.filter((_, i) => own.effects[i]);
  return acting.every((j, i) => i === 0 || j > acting[i - 1]!) ? at : null;
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

/**
 * What recordings teach each other before they are merged. A tool one
 * recording called once per item is a loop in all of them (a day with one
 * item shows a single call, a day with none shows nothing). A text argument
 * that is not identical in the same step of two recordings is never a
 * constant: it is written at run time, however short it is.
 */
export function learnHints(all: Compiled[]): CompileHints {
  const loopTools = new Set<string>();
  for (const c of all) {
    for (const t of c.sig) if (t.endsWith("*")) loopTools.add(t.slice(0, -1));
  }
  // the recording that made every step any other one made, as compileTraces picks it
  const base =
    [...all].reverse().find((c) => all.every((o) => align(o, c))) ??
    all[all.length - 1]!;
  const textArgs = new Set<string>();
  // a step that reads a list position (items.0.id) is a loop in disguise when
  // the position differs between recordings or the step is missing from some
  const positional = new Map<
    string,
    { templates: Set<string>; runs: number }
  >();
  for (const c of all) {
    const seen = new Set<string>();
    for (const step of c.workflow.steps) {
      if (step.type !== "tool") continue;
      for (const [key, v] of Object.entries(step.args)) {
        if (typeof v !== "string") continue;
        // a text written by the model in one recording is text in all of them
        const out = /^\{\{steps\.([^.}]+)\.output\}\}$/.exec(v);
        if (
          out &&
          c.workflow.steps.some((o) => o.id === out[1] && o.type === "llm")
        ) {
          textArgs.add(textArgKey(step.tool, key));
        }
        if (/\{\{steps\.[^}]*\.\d+(\.[^}]*)?\}\}/.test(v)) {
          const entry = positional.get(step.tool) ?? {
            templates: new Set(),
            runs: 0,
          };
          entry.templates.add(v);
          if (!seen.has(step.tool)) entry.runs++;
          seen.add(step.tool);
          positional.set(step.tool, entry);
        }
      }
    }
  }
  for (const [tool, { templates, runs }] of positional) {
    if (templates.size > 1 || runs < all.length) loopTools.add(tool);
  }
  for (const other of all) {
    if (other === base) continue;
    const ids = idMap(other, base);
    if (!ids) continue;
    for (const step of other.workflow.steps) {
      const mapped = base.workflow.steps.find((s) => s.id === ids.get(step.id));
      if (step.type !== "tool" || mapped?.type !== "tool") continue;
      for (const [key, a] of Object.entries(step.args)) {
        const b = mapped.args[key];
        const constant = (v: unknown): v is string =>
          typeof v === "string" && !v.includes("{{");
        if (constant(a) && constant(b) && a !== b) {
          textArgs.add(textArgKey(step.tool, key));
        }
      }
    }
  }
  return { loopTools, textArgs };
}

const hasHints = (h: CompileHints) =>
  (h.loopTools?.size ?? 0) > 0 || (h.textArgs?.size ?? 0) > 0;

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

/**
 * The recording the workflow is built from: the one that read the most list
 * items, the newest among equals. Figures are learned from it, and a day with
 * one item cannot tell a total from that item's amount.
 */
function richest(candidates: Compiled[]): Compiled {
  const size = (c: Compiled) =>
    c.results.reduce((n, r) => n + countItems(r.result), 0);
  return candidates.reduce((best, c) => (size(c) >= size(best) ? c : best));
}

/**
 * A tool step's schema is what EVERY recording's results had, not what the
 * recording the workflow was built from had: a field null in one recording and
 * a string in another must accept both, or the workflow stops on data it was
 * compiled from. Only when the recordings made the same steps in the same
 * order, so a step is the same step in each.
 */
function widenGuards(
  workflow: Workflow,
  base: Compiled,
  all: Compiled[],
): Workflow {
  if (
    all.length < 2 ||
    !all.every(
      (c) =>
        c.sig.join() === base.sig.join() && c.ids.length === base.ids.length,
    )
  ) {
    return workflow;
  }
  const schemas = new Map<string, Record<string, unknown>>();
  base.ids.forEach((id, i) => {
    const values: unknown[] = [];
    for (const c of all) {
      const found = c.results.find((r) => r.id === c.ids[i]);
      if (!found) return;
      if (found.field === "results")
        values.push(...(found.result as unknown[]));
      else values.push(found.result);
    }
    schemas.set(id, inferCommonSchema(values));
  });
  const widen = <T extends WorkflowStep>(step: T): T => {
    if (step.type === "tool" && step.guard.schema && schemas.has(step.id)) {
      return {
        ...step,
        guard: { ...step.guard, schema: schemas.get(step.id)! },
      };
    }
    if (step.type === "foreach" && schemas.has(step.id)) {
      return {
        ...step,
        body: step.body.map((b) =>
          b.guard.schema
            ? { ...b, guard: { ...b.guard, schema: schemas.get(step.id)! } }
            : b,
        ),
      };
    }
    return step;
  };
  return { ...workflow, steps: workflow.steps.map(widen) };
}

export function compileTraces(
  traces: TraceFile[],
  compiledFrom: string,
): BranchResult {
  const result = compileUsed(traces, compiledFrom, true);
  const usedTraces = result.used.map((i) => traces[i]!);
  return {
    ...result,
    workflow: {
      ...result.workflow,
      inputs: declareInputs(result.workflow.inputs, usedTraces),
    },
  };
}

/**
 * The workflow's inputs: required are the ones every recording had, the others
 * (a customer gave an email, not an order id) are optional, or a run with only
 * an email would be refused for the missing order id.
 */
function declareInputs(
  declared: Workflow["inputs"],
  traces: TraceFile[],
): Workflow["inputs"] {
  const inputs = traces.map((t) => t.meta.inputs);
  const optional = new Set(varyingInputs(inputs));
  const out: Workflow["inputs"] = { ...declared };
  for (const name of optional) {
    const from = [...inputs]
      .reverse()
      .find((i) => givenInputs(i, [name]).length);
    const value = from?.[name];
    out[name] = {
      ...(out[name] ?? { type: typeof value, example: value }),
      required: false,
    };
  }
  return out;
}

const signatureOf = (steps: Array<WorkflowStep | CaseStep>): string =>
  steps
    .map((s) =>
      s.type === "tool"
        ? `${s.tool}${JSON.stringify(s.args)}`
        : s.type === "foreach"
          ? `each ${s.over} ${signatureOf(s.body)}`
          : s.type,
    )
    .join(">");

/**
 * Recordings that were given different inputs (an order id, or an email) and
 * then took different steps: one workflow with a case per kind of input, each
 * case compiled from its own recordings. The rule is on the inputs, because
 * nothing has been read yet when the first step is chosen, so a question to
 * the replay model would have nothing to judge from. Null when the inputs do
 * not differ, the steps do not, or no input tells a group from the others.
 */
function splitByInputs(
  used: Array<{ t: TraceFile; i: number }>,
  compiledFrom: string,
): BranchResult | null {
  const inputs = used.map(({ t }) => t.meta.inputs);
  const names = varyingInputs(inputs);
  if (names.length === 0) return null;
  const groups = new Map<string, number[]>();
  inputs.forEach((inp, k) => {
    const key = givenInputs(inp, names).join();
    groups.set(key, [...(groups.get(key) ?? []), k]);
  });
  if (groups.size < 2) return null;
  const parts = [...groups].map(([key, members]) => ({
    key,
    members,
    result: compileUsed(
      members.map((k) => used[k]!.t),
      compiledFrom,
      false,
    ),
  }));
  if (
    parts.some((p) =>
      p.result.workflow.steps.some((s) => s.type === "branch"),
    ) ||
    new Set(parts.map((p) => signatureOf(p.result.workflow.steps))).size < 2
  ) {
    return null;
  }
  const newestPart = parts.findIndex((p) =>
    p.members.includes(used.length - 1),
  );
  const cases: BranchStep["cases"] = [];
  let otherwise: CaseStep[] | undefined;
  const recorded: RecordedResult[] = [];
  for (const [gi, part] of parts.entries()) {
    const own = part.result.workflow.steps as CaseStep[];
    const steps = gi === newestPart ? own : renameIds(own, `b${gi}`);
    recorded.push(
      ...(gi === newestPart
        ? part.result.recorded
        : renameRecorded(part.result.recorded, own, `b${gi}`)),
    );
    if (part.key === "") {
      otherwise = steps;
      continue;
    }
    const rule = learnInputRule(
      part.members.map((k) => inputs[k]!),
      parts
        .filter((o) => o !== part)
        .flatMap((o) => o.members.map((k) => inputs[k]!)),
    );
    if (!rule) return null;
    cases.push({ label: `${part.key} given`, when: rule, steps });
  }
  if (cases.length === 0) return null;
  const newestWorkflow = parts[newestPart]!.result.workflow;
  const branch: BranchStep = {
    id: "b1",
    type: "branch",
    cases,
    ...(otherwise ? { else: otherwise } : {}),
  };
  return {
    workflow: { ...newestWorkflow, steps: [branch], compiledFrom },
    used: used.map((u) => u.i),
    warnings: parts.flatMap((p) => p.result.warnings),
    notes: [
      `b1 chooses the path from the inputs: ${parts.map((p) => p.key || "none of them").join(" | ")}`,
      ...parts.flatMap((p) => p.result.notes),
    ],
    recorded,
  };
}

function compileUsed(
  traces: TraceFile[],
  compiledFrom: string,
  allowSplit: boolean,
): BranchResult {
  if (traces.length === 0) throw new Error("no recordings to compile");
  const newestTrace = traces[traces.length - 1]!;
  // newest last; older recordings with another data shape are left out
  const used = traces
    .map((t, i) => ({ t, i }))
    .filter(({ t }, i) => i === traces.length - 1 || sameShapes(t, newestTrace))
    .slice(-MAX_RECORDINGS);
  if (allowSplit && used.length > 1) {
    const split = splitByInputs(used, compiledFrom);
    if (split) return split;
  }
  const warnings: string[] = [];
  let all = used.map(({ t }) => compile(t, compiledFrom));
  const hints = learnHints(all);
  if (hasHints(hints)) {
    // first pass with the loops known: which items each tool acted on, in all recordings
    // (twice: the first pass finds the lists, the second counts the runs that skipped the tool)
    const sources = new Map<string, ListSource>();
    used.forEach(({ t }) =>
      compile(t, compiledFrom, { ...hints, samples: new Map(), sources }),
    );
    const samples = new Map<string, ItemSamples>();
    used.forEach(({ t }) =>
      compile(t, compiledFrom, { ...hints, samples, sources }),
    );
    const itemRules = new Map<string, Condition>();
    for (const [tool, got] of samples) {
      const rule = got.no.length > 0 ? learnItemRule(got.yes, got.no) : null;
      if (rule) itemRules.set(tool, rule);
    }
    all = used.map(({ t }) =>
      compile(t, compiledFrom, { ...hints, itemRules }),
    );
  }
  let newest = all[all.length - 1]!;
  const indices = used.map((u) => u.i);
  const finish = (base: Compiled, workflow: Workflow): BranchResult => {
    const learned = learnCoverage(base, workflow, all);
    return {
      workflow: widenGuards(learned.workflow, base, all),
      used: indices,
      warnings,
      notes: learned.notes,
      recorded: base.results,
    };
  };
  const plain = (): BranchResult => finish(newest, newest.workflow);
  if (all.length === 1) return plain();
  // an agent that looked at something the others never read (noise) should
  // not stop the recordings from being compared
  const quiet = all.map((c) => withoutNoise(c, all));
  if (
    quiet.some((c, i) => c.sig.length !== all[i]!.sig.length) &&
    quiet.some((c) => quiet.every((o) => align(o, c)))
  ) {
    all = quiet;
    newest = all[all.length - 1]!;
  }
  if (all.every((c) => c.sig.join() === newest.sig.join())) {
    const base = richest(all);
    return finish(base, base.workflow);
  }

  // the recording that made every step any other one made (prefer the newest)
  const bases = all.filter((c) => all.every((o) => align(o, c)));
  const base = bases.length > 0 ? richest(bases) : undefined;
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
  const placed = all.map((c) => align(c, base)!);
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

  // numbers the agents wrote ("above the 2% threshold") and every number the
  // tools returned: a threshold is a written number that no data holds
  const written = all.flatMap((c) =>
    c.trace.calls.flatMap((call) =>
      Object.values(call.args)
        .filter((v): v is string => typeof v === "string")
        .flatMap((v) => numbersInText(v)),
    ),
  );
  const dataValues = new Set<number>();
  const collect = (v: unknown): void => {
    if (typeof v === "number") dataValues.add(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v !== null && typeof v === "object")
      Object.values(v).forEach(collect);
  };
  for (const c of all) for (const call of c.trace.calls) collect(call.result);

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
    const rule =
      learnRule(yesK.map(before), noK.map(before)) ??
      learnNumberRule(yesK.map(before), noK.map(before), written, dataValues) ??
      learnInputRule(
        yesK.map((k) => all[k]!.trace.meta.inputs),
        noK.map((k) => all[k]!.trace.meta.inputs),
      );
    const condition =
      rule ?? askCondition(base, all, i, groupIds, yesK[0]!, noK[0]!, always);
    if (!condition) {
      // nothing has been read yet, so a question would have no data to judge
      // from: the steps always run, and a wrong guess shows as drift
      warnings.push(
        `${groupIds.join(", ")} ran in only some recordings and nothing before them tells the recordings apart; they always run`,
      );
      i = end + 1;
      continue;
    }
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
  const placed = align(own, base);
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
): Condition | null {
  // the data a run has before the step: always-present read-only results
  const refs = base.ids
    .slice(0, start)
    .filter((_, ix) => always[ix])
    .map((id) => {
      const field = base.recorded.has(`${id}.results`) ? "results" : "result";
      return { id, field, tool: base.sig[base.ids.indexOf(id)]! };
    });
  if (refs.length === 0) return null;
  const prompt = refs
    .map((r) => `${r.id} ${r.tool} ${r.field}:\n{{steps.${r.id}.${r.field}}}`)
    .join("\n\n");
  const dataOf = (k: number) => {
    const c = all[k]!;
    const placedK = align(c, base)!;
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
