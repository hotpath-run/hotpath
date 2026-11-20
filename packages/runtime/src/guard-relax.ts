import { Ajv } from "ajv";
import type {
  Condition,
  StepGuard,
  Workflow,
  WorkflowStep,
} from "@hotpathrun/shared";

// A tool step's guard is learned from recordings: every field it saw is
// required and has the type it had. That catches a renamed or retyped field,
// but it also stops a run on a field nothing uses: an order still in transit
// has `delivered_on: null` where every recording had a date, and each replay
// drifted for it (5 of 5 in the shop sandbox).
//
// Only nulls are let through, and only on fields nothing in the workflow
// depends on. A field that is absent or of another type still stops (that is
// what a rename looks like), and so does a null in a value a later step
// reads: a template, a `foreach` item, a condition, a grounding path.
// Done at run time, from the workflow itself, so workflows compiled before
// this rule get it too.

/** A path into a step's result (`result.items.*.name` -> ["items", "*", "name"]). */
interface Use {
  path: string[];
  /**
   * The list is only iterated: it must be a list, but its items are used only
   * through the paths that name their fields.
   */
  structure: boolean;
  /** read only by a step that may not run: a null there stops that step, not the source */
  conditional?: boolean;
}

interface Alias {
  as: string;
  /** where the item comes from; null when `over` is not a step result */
  base: { step: string; path: string[] } | null;
}

interface Uses {
  byStep: Map<string, Use[]>;
  /** loops whose collected `results` something reads: their body is left strict */
  loopResults: Map<string, Use[]>;
  /** set while scanning steps that run only on a condition */
  conditional?: boolean;
}

const SEG = "[A-Za-z0-9_*-]+";
// steps.s1.result.a.b | steps.s3.1.result.x | steps.s3.results.0.x
const STEP_REF = new RegExp(
  `steps\\.([A-Za-z_]\\w*(?:\\.\\d+)*)\\.(result|results|output)(?![\\w])((?:\\.${SEG})*)`,
  "g",
);
const TEMPLATE = /\{\{([^{}]+)\}\}/g;

const segments = (tail: string): string[] =>
  tail.split(".").filter((s) => s !== "");

function addUse(uses: Uses, step: string, use: Use): void {
  const list = uses.byStep.get(step) ?? [];
  list.push(uses.conditional ? { ...use, conditional: true } : use);
  uses.byStep.set(step, list);
}

/** Every reference in `text`; `viewOnly` text (a prompt) may show a whole result without depending on it. */
function scanText(
  text: string,
  uses: Uses,
  aliases: Alias[],
  viewOnly: boolean,
): void {
  for (const m of text.matchAll(STEP_REF)) {
    const [, id, field, tail] = m as unknown as [
      string,
      string,
      string,
      string,
    ];
    const path = segments(tail);
    if (path.length === 0 && viewOnly) continue;
    if (field === "results") {
      // a loop's results are its last body step's result per item:
      // results.<index>.<path> reads <path> of that step's result
      const list = uses.loopResults.get(id) ?? [];
      const rest = path.length > 0 && isIndex(path[0]!) ? path.slice(1) : [];
      list.push({
        path: rest,
        structure: false,
        ...(uses.conditional ? { conditional: true } : {}),
      });
      uses.loopResults.set(id, list);
      continue;
    }
    if (field !== "result") continue;
    addUse(uses, id, { path, structure: false });
  }
  if (aliases.length === 0) return;
  // aliases are only looked for inside {{ }}, a bare word like "it" in a
  // sentence is not a reference
  for (const t of text.matchAll(TEMPLATE)) scanAlias(t[1]!, uses, aliases);
}

function scanAlias(expr: string, uses: Uses, aliases: Alias[]): void {
  for (const alias of aliases) {
    const re = new RegExp(
      `(?<![\\w.])${alias.as}((?:\\.${SEG})*)(?![\\w])`,
      "g",
    );
    for (const m of expr.matchAll(re)) {
      if (!alias.base) continue;
      addUse(uses, alias.base.step, {
        path: [...alias.base.path, "*", ...segments(m[1]!)],
        structure: false,
      });
    }
  }
}

function scanValue(
  value: unknown,
  uses: Uses,
  aliases: Alias[],
  viewOnly = false,
): void {
  if (typeof value === "string") scanText(value, uses, aliases, viewOnly);
  else if (Array.isArray(value)) {
    for (const v of value) scanValue(v, uses, aliases, viewOnly);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) scanValue(v, uses, aliases, viewOnly);
  }
}

function scanCondition(
  when: Condition | undefined,
  uses: Uses,
  aliases: Alias[],
): void {
  if (!when) return;
  if (when.kind === "ask") {
    scanText(when.prompt, uses, aliases, true);
    return;
  }
  // "is it empty" looks at the value itself, not at what its items hold
  const emptiness = when.kind === "nonEmpty" || when.kind === "empty";
  const target = emptiness ? resolveList(when.ref, aliases) : null;
  if (target && target !== "results") {
    addUse(uses, target.step, { path: target.path, structure: true });
    return;
  }
  scanText(when.ref, uses, aliases, false);
  // a bare alias reference (no braces) in a condition of a loop body
  scanAlias(when.ref, uses, aliases);
}

/** The list a `over` / row `over` points at, if it is a step result or a loop item. */
function resolveList(
  expr: string,
  aliases: Alias[],
): { step: string; path: string[] } | "results" | null {
  const text = expr.replace(/^\s*\{\{|\}\}\s*$/g, "").trim();
  const step = new RegExp(`^${STEP_REF.source}$`).exec(text);
  if (step) {
    if (step[2] !== "result") return "results";
    return { step: step[1]!, path: segments(step[3]!) };
  }
  for (const alias of aliases) {
    const m = new RegExp(`^${alias.as}((?:\\.${SEG})*)$`).exec(text);
    if (m && alias.base) {
      return {
        step: alias.base.step,
        path: [...alias.base.path, "*", ...segments(m[1]!)],
      };
    }
  }
  return null;
}

/** every string in `node` except under the given keys */
function stringsIn(
  node: unknown,
  skip: string[],
  out: string[] = [],
): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const v of node) stringsIn(v, skip, out);
  else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (!skip.includes(k)) stringsIn(v, skip, out);
    }
  }
  return out;
}

/**
 * Calculations and selections name a list and then item fields relative to it
 * ("amount", "currency"). Every string beside a `list` is taken as a possible
 * field name of its items: more than needed, never less. Anything else is
 * scanned for references as usual.
 */
function scanSpec(node: unknown, uses: Uses, aliases: Alias[]): void {
  if (Array.isArray(node)) {
    for (const v of node) scanSpec(v, uses, aliases);
    return;
  }
  if (node === null || typeof node !== "object") {
    scanValue(node, uses, aliases);
    return;
  }
  const obj = node as Record<string, unknown>;
  const list =
    typeof obj.list === "string" ? resolveList(obj.list, aliases) : null;
  if (list && list !== "results") {
    addUse(uses, list.step, { path: list.path, structure: true });
    for (const name of stringsIn(obj, ["list", "line"])) {
      addUse(uses, list.step, {
        path: [...list.path, "*", ...segments(name)],
        structure: false,
      });
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === "line" || (k === "list" && list && list !== "results")) continue;
    scanSpec(v, uses, aliases);
  }
}

function scanStep(step: WorkflowStep, uses: Uses, aliases: Alias[]): void {
  // a step with a condition reads its data only when it runs; its own
  // condition is decided on every run, so it is scanned as unconditional
  const outer = uses.conditional;
  scanStepInner(step, uses, aliases);
  uses.conditional = outer;
}

function scanStepInner(step: WorkflowStep, uses: Uses, aliases: Alias[]): void {
  const outer = uses.conditional;
  const own = (fn: () => void) => {
    uses.conditional = outer || step.when !== undefined;
    fn();
    uses.conditional = outer;
  };
  switch (step.type) {
    case "tool":
      own(() => scanValue(step.args, uses, aliases));
      scanCondition(step.when, uses, aliases);
      // the merged pages are read by the runtime itself
      if (step.paginate) addUse(uses, step.id, { path: [], structure: false });
      return;
    case "llm": {
      scanCondition(step.when, uses, aliases);
      uses.conditional = outer || step.when !== undefined;
      scanText(step.prompt, uses, aliases, true);
      // exampleFacts are recorded values, not references
      const guard = {
        ...step.guard,
        exampleFacts: undefined,
        schema: undefined,
      };
      scanSpec(guard, uses, aliases);
      scanSpec(step.calculations ?? [], uses, aliases);
      for (const row of step.layout?.rows ?? []) {
        const list = resolveList(row.over, aliases);
        if (!list || list === "results") {
          scanValue(row.over, uses, aliases);
          continue;
        }
        addUse(uses, list.step, { path: list.path, structure: true });
        for (const m of row.template.matchAll(
          /\{\{item((?:\.[^.{}\s]+)*)\}\}/g,
        )) {
          addUse(uses, list.step, {
            path: [...list.path, "*", ...segments(m[1]!)],
            structure: false,
          });
        }
      }
      return;
    }
    case "foreach": {
      scanCondition(step.when, uses, aliases);
      uses.conditional = outer || step.when !== undefined;
      const list = resolveList(step.over, aliases);
      if (list === "results") scanValue(step.over, uses, aliases);
      else if (list) {
        addUse(uses, list.step, { path: list.path, structure: true });
      }
      const inner: Alias[] = [
        ...aliases,
        { as: step.as, base: list && list !== "results" ? list : null },
      ];
      for (const b of step.body) scanStep(b, uses, inner);
      return;
    }
    case "branch":
      scanCondition(step.when, uses, aliases);
      for (const c of step.cases) {
        // every case's condition is evaluated in turn; its steps run only when it fits
        uses.conditional = outer;
        scanCondition(c.when, uses, aliases);
        uses.conditional = true;
        for (const s of c.steps) scanStep(s, uses, aliases);
      }
      uses.conditional = true;
      for (const s of step.else ?? []) scanStep(s, uses, aliases);
      return;
  }
}

/**
 * `null` added to the types, as a set: a field recorded as null stays null, a
 * type list already holding null is unchanged. A schema with enum/const is left
 * as recorded (a null would have to be listed there too).
 */
function allowNull(schema: Record<string, unknown>): Record<string, unknown> {
  if ("enum" in schema || "const" in schema) return schema;
  const types = Array.isArray(schema.type)
    ? (schema.type as unknown[])
    : typeof schema.type === "string"
      ? [schema.type]
      : null;
  if (!types) return schema;
  // recorded only as null (a parcel not shipped yet): any type may come later
  if (types.every((t) => t === "null")) {
    const rest = { ...schema };
    delete rest.type;
    return rest;
  }
  if (types.includes("null")) return schema;
  return { ...schema, type: [...types, "null"] };
}

const isIndex = (seg: string) => seg === "*" || /^\d+$/.test(seg);

/** The schema with `null` allowed on every field nothing depends on. */
export function relaxUnused(
  schema: Record<string, unknown>,
  uses: Use[],
): Record<string, unknown> {
  // something reads this whole value
  if (uses.some((u) => u.path.length === 0 && !u.structure)) return schema;
  const reading = uses.filter((u) => u.path.length > 0);

  const child = (
    node: unknown,
    below: Use[],
  ): Record<string, unknown> | undefined => {
    if (node === null || typeof node !== "object") return undefined;
    const sub = node as Record<string, unknown>;
    if (below.length > 0) return relaxUnused(sub, below);
    const inner = relaxUnused(sub, []);
    return allowNull(inner);
  };
  const tails = (match: (seg: string) => boolean): Use[] =>
    reading
      .filter((u) => match(u.path[0]!))
      .map((u) => ({ ...u, path: u.path.slice(1) }));

  if (
    schema.type === "object" &&
    schema.properties !== null &&
    typeof schema.properties === "object"
  ) {
    const properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, unknown>).map(
        ([key, node]) => [
          key,
          child(
            node,
            tails((s) => s === key),
          ) ?? node,
        ],
      ),
    );
    return { ...schema, properties };
  }
  if (schema.type === "array" && schema.items) {
    const items = child(schema.items, tails(isIndex));
    return items ? { ...schema, items } : schema;
  }
  return schema;
}

/**
 * The guards of every tool step, keyed by step id, with the schema relaxed on
 * fields nothing in the workflow reads. Steps without a schema are not listed.
 */
export function relaxedGuards(workflow: Workflow): Map<string, StepGuard> {
  const uses: Uses = { byStep: new Map(), loopResults: new Map() };
  for (const step of workflow.steps) scanStep(step, uses, []);

  const out = new Map<string, StepGuard>();
  const visit = (step: WorkflowStep, loop?: string, last = false) => {
    if (step.type === "tool") {
      if (!step.guard.schema) return;
      const read = [
        ...(uses.byStep.get(step.id) ?? []),
        ...(loop && last ? (uses.loopResults.get(loop) ?? []) : []),
      ].filter((u) => !u.conditional);
      const relaxed = relaxUnused(step.guard.schema, read);
      // a relaxing bug must only ever mean a stop, never an invalid schema
      try {
        new Ajv({ strict: false }).compile(relaxed);
        out.set(step.id, { ...step.guard, schema: relaxed });
      } catch {
        out.set(step.id, step.guard);
      }
    } else if (step.type === "foreach") {
      step.body.forEach((b, i) =>
        visit(b, step.id, i === step.body.length - 1),
      );
    } else if (step.type === "branch") {
      for (const c of step.cases) for (const s of c.steps) visit(s);
      for (const s of step.else ?? []) visit(s);
    }
  };
  for (const step of workflow.steps) visit(step);
  return out;
}
