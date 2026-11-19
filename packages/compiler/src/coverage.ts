import {
  mentions,
  type GroundingEntry,
  type LlmStep,
  type Workflow,
} from "@hotpathrun/shared";

import type { RecordedResult } from "./compiler.js";

// Recording quality (task 02). A workflow is learned from one message an
// agent wrote. If that message left something out, the workflow faithfully
// leaves it out too, and nothing in a replay notices. This module measures what
// the recorded message covers, says so at compile time, and lets the user (or
// another recording) require a field for every item of a list.

/** One list the AI step reads, and how much of it the recorded message mentions. */
export interface ListCoverage {
  /** the AI step */
  step: string;
  /** the list, as a template reference; nested lists use `*` (steps.s3.results.*.commits) */
  list: string;
  /** items in the recording (all nested lists together) */
  items: number;
  /** the best covered field of an item ("subject"); "" when the items are plain values */
  field: string;
  /** items whose `field` the message mentions */
  mentioned: number;
  /** the workflow requires `field` for every item */
  required: boolean;
}

// Field names that usually identify an item for a reader, best first.
const KEY_FIELDS = [
  "title",
  "subject",
  "name",
  "summary",
  "headline",
  "label",
  "message",
  "text",
  "description",
  "id",
];

const MIN_STRING = 4;

function usable(value: unknown): value is string | number {
  if (typeof value === "string") return value.trim().length >= MIN_STRING;
  if (typeof value === "number" && Number.isFinite(value)) {
    return !Number.isInteger(value) || Math.abs(value) >= 10;
  }
  return false;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Every list inside `node` with its path; indices of outer lists become `*`. */
function listsIn(
  node: unknown,
  path: string[] = [],
): Array<{ path: string[]; items: unknown[] }> {
  const found: Array<{ path: string[]; items: unknown[] }> = [];
  if (Array.isArray(node)) {
    if (node.length > 0) found.push({ path, items: node });
    for (const item of node) found.push(...listsIn(item, [...path, "*"]));
  } else if (isObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      found.push(...listsIn(v, [...path, k]));
    }
  }
  return found;
}

/** An item's plain values by path ("subject", "author.name"); lists inside are separate lists. */
function leaves(
  item: unknown,
  prefix: string[] = [],
  out = new Map<string, unknown>(),
): Map<string, unknown> {
  if (isObject(item)) {
    for (const [k, v] of Object.entries(item)) leaves(v, [...prefix, k], out);
  } else if (!Array.isArray(item)) {
    out.set(prefix.join("."), item);
  }
  return out;
}

/** The step ids an AI step's prompt reads: `{{steps.s1.result}}` → s1. */
export function promptSources(prompt: string): Set<string> {
  const ids = new Set<string>();
  for (const m of prompt.matchAll(
    /\{\{steps\.([^.}]+)\.(?:result|results)\b/g,
  )) {
    ids.add(m[1]!);
  }
  return ids;
}

function wildcardPaths(step: LlmStep): Set<string> {
  return new Set(
    (step.guard.grounding ?? [])
      // a `positions` entry asks for some items, not every item
      .filter((g) => g.positions === undefined)
      .flatMap((g) => g.paths)
      .filter((p) => p.includes("*")),
  );
}

/**
 * For every list an AI step reads: which field of its items the recorded
 * message mentions most, for how many items, and whether the workflow requires
 * it for every item. Lists with the same shape (the commits of each
 * repository) are counted together.
 */
export function listCoverage(
  workflow: Workflow,
  recorded: RecordedResult[],
): ListCoverage[] {
  const out: ListCoverage[] = [];
  for (const step of workflow.steps) {
    if (step.type !== "llm") continue;
    const sources = promptSources(step.prompt);
    const required = wildcardPaths(step);
    const groups = new Map<
      string,
      {
        items: number;
        lists: number;
        counts: Map<string, number>;
        fields: string[];
      }
    >();
    for (const source of recorded) {
      if (!sources.has(source.id)) continue;
      for (const list of listsIn(source.result)) {
        const ref = ["steps", source.id, source.field, ...list.path].join(".");
        const group = groups.get(ref) ?? {
          items: 0,
          lists: 0,
          counts: new Map<string, number>(),
          fields: [],
        };
        groups.set(ref, group);
        group.lists++;
        for (const item of list.items) {
          group.items++;
          for (const [field, value] of leaves(item)) {
            if (!usable(value)) continue;
            if (!group.fields.includes(field)) group.fields.push(field);
            if (mentions(step.example, value)) {
              group.counts.set(field, (group.counts.get(field) ?? 0) + 1);
            }
          }
        }
      }
    }
    for (const [list, group] of groups) {
      if (group.fields.length === 0) continue; // nothing a reader could name
      const rank = (field: string) => {
        const key = field.split(".").at(-1)!.toLowerCase();
        const i = KEY_FIELDS.indexOf(key);
        return i < 0 ? KEY_FIELDS.length : i;
      };
      const best = [...group.fields].sort(
        (a, b) =>
          (group.counts.get(b) ?? 0) - (group.counts.get(a) ?? 0) ||
          rank(a) - rank(b) ||
          group.fields.indexOf(a) - group.fields.indexOf(b),
      )[0]!;
      const path = best === "" ? `${list}.*` : `${list}.*.${best}`;
      out.push({
        step: step.id,
        list,
        items: group.items,
        field: best,
        mentioned: group.counts.get(best) ?? 0,
        // a nested list is required through one path per outer item: all of
        // them must be there
        required:
          required.has(path) ||
          [...required].filter((r) => sameShape(r, path)).length >= group.lists,
      });
    }
  }
  return out;
}

/**
 * Marks the AI steps whose recorded text is a selection: some list they read
 * is covered only in part and not required for every item. The compiled prompt
 * says "cover every item", which makes a small model list everything and lose
 * the point of the recording (measured: a reconciliation that should report
 * the unmatched lines and their total listed all lines and dropped the total).
 */
export function markSelective(
  workflow: Workflow,
  recorded: RecordedResult[],
): Workflow {
  const partial = new Set(
    listCoverage(workflow, recorded)
      .filter((c) => !c.required && c.mentioned < c.items)
      .map((c) => c.step),
  );
  if (partial.size === 0) return workflow;
  return {
    ...workflow,
    steps: workflow.steps.map((s) =>
      s.type === "llm" && partial.has(s.id) ? { ...s, selective: true } : s,
    ),
  };
}

/** steps.s3.results.0.commits.*.message is the 0th case of steps.s3.results.*.commits.*.message */
function sameShape(concrete: string, pattern: string): boolean {
  const a = concrete.split(".");
  const b = pattern.split(".");
  return (
    a.length === b.length &&
    a.every((part, i) => part === b[i] || (b[i] === "*" && /^\d+$/.test(part)))
  );
}

const MAX_COVERAGE_WARNINGS = 6;

/** "emails" from steps.s1.result.emails; "items" when the path has no name. */
function noun(list: string): string {
  const name = list
    .split(".")
    .filter((p) => p !== "*" && !/^\d+$/.test(p))
    .at(-1);
  return !name || name === "result" || name === "results" ? "items" : name;
}

/**
 * What to tell the user at compile time: lists the recorded message covers only
 * in part, or not at all. A list that is fully mentioned, or already required
 * for every item, is fine.
 */
export function coverageWarnings(coverage: ListCoverage[]): string[] {
  const weak = coverage.filter((c) => !c.required && c.mentioned < c.items);
  const warnings = weak.slice(0, MAX_COVERAGE_WARNINGS).map((c) => {
    const what = noun(c.list);
    const path = c.field === "" ? `${c.list}.*` : `${c.list}.*.${c.field}`;
    const fix =
      `If every one belongs in the text, record the task again with an agent that covers them, ` +
      `or compile with --require ${path}`;
    return c.mentioned === 0
      ? `${c.step}: the recorded text mentions none of the ${c.items} ${what} ` +
          `(${c.list}), so the workflow will not check for them. ${fix}`
      : `${c.step}: the recorded text mentions ${c.mentioned} of ${c.items} ${what} ` +
          `(${c.list}, by ${c.field || "value"}), so the workflow is only required ` +
          `to mention ${c.mentioned === 1 ? "that one" : "those"}. ${fix}`;
  });
  if (weak.length > MAX_COVERAGE_WARNINGS) {
    const more = weak.length - MAX_COVERAGE_WARNINGS;
    warnings.push(
      `${more} more list${more === 1 ? " is" : "s are"} covered only in part ` +
        `(${weak
          .slice(MAX_COVERAGE_WARNINGS)
          .map((c) => c.list)
          .join(", ")})`,
    );
  }
  return warnings;
}

/** A `--require` path that cannot be used, with what to do instead. */
export class RequireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequireError";
  }
}

export interface Requirement {
  /** only this AI step ("s4:steps.s1.result.emails.*.subject"); default: every AI step that reads the data */
  step?: string;
  path: string;
}

const REQUIRE_RE =
  /^(?:([A-Za-z0-9_.]+):)?(steps\.[A-Za-z0-9_]+(?:\.\d+)*\.(?:result|results)(?:\.[^.\s{}]+)+)$/;

export function parseRequirement(text: string): Requirement {
  const m = REQUIRE_RE.exec(text.trim());
  if (!m) {
    throw new RequireError(
      `--require ${JSON.stringify(text)} is not a path into a step's result. ` +
        "Use the form steps.<id>.result.<list>.*.<field>, for example " +
        "steps.s1.result.emails.*.subject (hotpath show <task> lists the steps)",
    );
  }
  return { ...(m[1] ? { step: m[1] } : {}), path: m[2]! };
}

/** The recorded values a path names (`*` = every item of a list). */
function valuesAt(path: string, recorded: RecordedResult[]): unknown[] | null {
  const parts = path.split(".");
  const source = recorded.find(
    (r) => r.id === parts[1] && r.field === parts[2],
  );
  if (!source) return null;
  let nodes: unknown[] = [source.result];
  for (const part of parts.slice(3)) {
    const next: unknown[] = [];
    for (const node of nodes) {
      if (part === "*") {
        if (Array.isArray(node)) next.push(...node);
      } else if (Array.isArray(node)) {
        if (/^\d+$/.test(part) && Number(part) < node.length) {
          next.push(node[Number(part)]);
        }
      } else if (isObject(node) && Object.hasOwn(node, part)) {
        next.push(node[part]);
      }
    }
    nodes = next;
  }
  return nodes;
}

export interface RequireResult {
  workflow: Workflow;
  /** "s4 must mention steps.s1.result.emails.*.subject (3 items in the recording)" */
  applied: string[];
  warnings: string[];
}

/**
 * Makes each path a requirement of the AI step(s) that read its data: at run
 * time the text must mention what the path holds for every item. The
 * requirements are kept in `workflow.require`, so a later recompile (after a
 * fallback) applies them again.
 *
 * `strict` (paths typed just now): a path that does not fit the recording is an
 * error. Otherwise (paths carried over from the previous workflow) it is a
 * warning: the new recording may have other steps.
 */
export function applyRequirements(
  workflow: Workflow,
  recorded: RecordedResult[],
  requirements: string[],
  strict: boolean,
): RequireResult {
  const applied: string[] = [];
  const warnings: string[] = [];
  const kept: string[] = [];
  let steps = workflow.steps;
  for (const text of [...new Set(requirements)]) {
    const fail = (message: string) => {
      if (strict) throw new RequireError(message);
      warnings.push(
        `${message} (kept from the previous workflow; not applied)`,
      );
      kept.push(text);
    };
    let requirement: Requirement;
    try {
      requirement = parseRequirement(text);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      continue;
    }
    const sourceId = requirement.path.split(".")[1]!;
    const values = valuesAt(requirement.path, recorded);
    if (values === null) {
      fail(
        `--require ${requirement.path}: the recording has no step ${sourceId} with that result ` +
          "(hotpath show <task> lists the steps)",
      );
      continue;
    }
    const usableValues = values.filter(
      (v): v is string | number =>
        typeof v === "string" || (typeof v === "number" && Number.isFinite(v)),
    );
    const star = requirement.path.lastIndexOf(".*");
    const items =
      star >= 0
        ? (valuesAt(requirement.path.slice(0, star + 2), recorded) ?? [])
        : [];
    if (values.length === 0 && items.length > 0) {
      fail(
        `--require ${requirement.path}: no items in the recording have that field ` +
          `(the ${items.length} there have: ${Object.keys(
            isObject(items[0]) ? items[0] : {},
          ).join(", ")})`,
      );
      continue;
    }
    if (values.length > 0 && usableValues.length === 0) {
      fail(
        `--require ${requirement.path}: that path holds no text or number in the recording ` +
          "(point it at a field, such as …emails.*.subject)",
      );
      continue;
    }
    const readers = steps.filter(
      (s): s is LlmStep =>
        s.type === "llm" &&
        promptSources(s.prompt).has(sourceId) &&
        (requirement.step === undefined || s.id === requirement.step),
    );
    if (readers.length === 0) {
      fail(
        requirement.step
          ? `--require ${text}: ${requirement.step} is not an AI step that reads ${sourceId}`
          : `--require ${requirement.path}: no AI step reads ${sourceId}, so nothing would check it`,
      );
      continue;
    }
    const entry: GroundingEntry = {
      // shown to people reading the workflow; the run checks the path
      value: usableValues[0] ?? "",
      paths: [requirement.path],
    };
    const ids = new Set(readers.map((s) => s.id));
    steps = steps.map((s) => {
      if (s.type !== "llm" || !ids.has(s.id)) return s;
      const grounding = s.guard.grounding ?? [];
      if (grounding.some((g) => g.paths.includes(requirement.path))) return s;
      return { ...s, guard: { ...s.guard, grounding: [...grounding, entry] } };
    });
    kept.push(text);
    const count = values.length;
    applied.push(
      `${[...ids].join(", ")} must mention ${requirement.path}` +
        (requirement.path.includes("*")
          ? ` (${count} item${count === 1 ? "" : "s"} in the recording)`
          : ""),
    );
    if (values.length === 0) {
      warnings.push(
        `--require ${requirement.path}: the recording has no items there, so the field name could not be checked`,
      );
    }
  }
  return {
    workflow: {
      ...workflow,
      steps,
      ...(kept.length > 0 ? { require: kept } : {}),
    },
    applied,
    warnings,
  };
}
