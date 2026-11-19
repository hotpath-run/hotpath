import {
  learnRules,
  learnRulesFromText,
  type GroundingEntry,
  type TemplateContext,
} from "@hotpathrun/shared";

/** `steps.s1.result.emails.2.from` → list prefix, item index, field inside the item. */
function splitIndex(
  ref: string,
): { prefix: string; index: number; rel: string } | null {
  const parts = ref.split(".");
  for (let i = parts.length - 1; i >= 3; i--) {
    if (/^\d+$/.test(parts[i]!)) {
      return {
        prefix: parts.slice(0, i).join("."),
        index: Number(parts[i]),
        rel: parts.slice(i + 1).join("."),
      };
    }
  }
  return null;
}

/** The list a wildcard path runs over: `steps.s1.result.emails.*.subject` → `steps.s1.result.emails`. */
function wildcardPrefix(ref: string): string | null {
  const at = ref.lastIndexOf(".*");
  return at < 0 ? null : ref.slice(0, at);
}

/** `steps.s1.result.issues.0.labels` is inside an item of `steps.s1.result.issues`: is that list required item by item? */
function outerCovered(prefix: string, covered: Set<string>): boolean {
  const parts = prefix.split(".");
  for (let i = parts.length - 1; i >= 3; i--) {
    if (/^\d+$/.test(parts[i]!) && covered.has(parts.slice(0, i).join("."))) {
      return true;
    }
  }
  return false;
}

/**
 * A requirement tied to one position of a list ("the 3rd email's sender must
 * be named") is an accident of the recording: tomorrow's 3rd email is a
 * different one. Measured on morning-brief: the recording named one sender by
 * address and the others by first name, so every replay on new data was
 * rejected for not writing "dave@club.org", although it covered the item.
 *
 * Position-specific requirements become what they were meant to say:
 *  - a list that already has a requirement for every item (`emails.*.subject`):
 *    each item is covered through it, so the positional ones are redundant and
 *    dropped;
 *  - a list with no such requirement: as many different items must be mentioned
 *    as there are recorded positions that still exist today (never more than the
 *    old per-position check asked) (`positions`), through any of the fields it used.
 * Values that are not inside a list (the weather's temperature) are untouched.
 */
export function relaxPositional(entries: GroundingEntry[]): GroundingEntry[] {
  const covered = new Set<string>();
  for (const e of entries) {
    for (const p of e.paths) {
      const prefix = wildcardPrefix(p);
      if (prefix !== null) covered.add(prefix);
    }
  }
  const pending = new Map<
    string,
    { indices: Set<number>; fields: Set<string>; value: string | number }
  >();
  const out: GroundingEntry[] = [];
  for (const e of entries) {
    const kept: string[] = [];
    for (const ref of e.paths) {
      const s = splitIndex(ref);
      if (!s) {
        kept.push(ref);
        continue;
      }
      if (covered.has(s.prefix)) continue; // every item is already required
      // a tag inside one item of a list whose items are all required
      // (`issues.0.labels.0` when `issues.*.number` is): tomorrow's first
      // issue is another one, and the item is checked through its own field
      if (outerCovered(s.prefix, covered)) continue;
      const group = pending.get(s.prefix) ?? {
        indices: new Set<number>(),
        fields: new Set<string>(),
        value: e.value,
      };
      group.indices.add(s.index);
      group.fields.add(s.rel ? `${s.prefix}.*.${s.rel}` : `${s.prefix}.*`);
      pending.set(s.prefix, group);
    }
    if (kept.length > 0) out.push({ value: e.value, paths: kept });
  }
  for (const group of pending.values()) {
    out.push({
      value: group.value,
      paths: [...group.fields],
      positions: [...group.indices].sort((a, b) => a - b),
    });
  }
  return out;
}

// fields that name an item in a report, best first
const KEY_NAMES = [
  "ref",
  "id",
  "number",
  "name",
  "title",
  "subject",
  "sku",
  "code",
];

/**
 * A `positions` entry says "the recording cited these items of the list"; this
 * adds the rule that picked them (see selection.ts), when a simple rule
 * reproduces exactly that choice on the recorded data. Without one the entry
 * stays as it is.
 */
export function withSelectionRules(
  entries: GroundingEntry[],
  results: Array<{ id: string; result: unknown; field?: "result" | "results" }>,
  example?: string,
): GroundingEntry[] {
  const ctx: TemplateContext = { inputs: {}, steps: {} };
  for (const r of results) {
    ctx.steps[r.id] = (
      r.field === "results" ? { results: r.result } : { result: r.result }
    ) as never;
  }
  return entries.map((e) => {
    if (!e.positions) return e;
    const list = wildcardPrefix(e.paths[0]!);
    if (list === null || list.includes(".*")) return e; // nested lists: not yet
    const fields = e.paths.map((p) => p.slice(list.length + 3));
    const key =
      KEY_NAMES.map((k) => fields.find((f) => f.toLowerCase() === k)).find(
        Boolean,
      ) ?? fields[0]!;
    const { rules } =
      example === undefined
        ? { rules: learnRules(list, e.positions, ctx) }
        : learnRulesFromText(list, e.positions, ctx, example, key);
    if (rules.length === 0) return e;
    return { ...e, select: { list, key, rules } };
  });
}
