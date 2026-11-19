// Which items of a list a recording selected, as a rule that can be applied to
// another day's data. A reconciliation reports "the bank lines that are not in
// the ledger": the recorded report cites lines 3 and 6, but tomorrow the rule
// picks other lines. Knowing the rule, the guard can require exactly today's
// selected items, and the prompt can name them, instead of "as many items as
// were recorded" (which accepts the wrong ones).
//
// Only rules that reproduce the recorded selection exactly are learned, and
// only simple ones: membership in another list, a field equal to a value, the
// sign of a number. When several fit the recording, each is kept and an item
// counts as selected only if every rule selects it (rules that disagree on new
// data never make the guard ask for more than all of them agree on).
import { z } from "zod";

import { lookupReference, type TemplateContext } from "./template.js";

export const selectionRuleSchema = z.discriminatedUnion("kind", [
  /** item.field is (in) or is not (notIn) one of the values of other.*.otherField */
  z.object({
    kind: z.enum(["in", "notIn"]),
    field: z.string(),
    other: z.string(),
    otherField: z.string(),
  }),
  z.object({
    kind: z.literal("equals"),
    field: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
  z.object({
    kind: z.enum(["negative", "positive"]),
    field: z.string(),
  }),
]);
export type SelectionRule = z.infer<typeof selectionRuleSchema>;

export const selectionSchema = z.object({
  /** the list (template reference without braces), e.g. steps.s1.result.lines */
  list: z.string(),
  /** the field that names an item in a text (ref, id, name…) */
  key: z.string(),
  rules: z.array(selectionRuleSchema).min(1),
});
export type Selection = z.infer<typeof selectionSchema>;

type Item = Record<string, unknown>;
const isItem = (v: unknown): v is Item =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const scalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v));

/** true / false per item; null when the rule cannot be applied to this data. */
export function applyRule(
  rule: SelectionRule,
  items: Item[],
  ctx: TemplateContext,
): boolean[] | null {
  if (rule.kind === "in" || rule.kind === "notIn") {
    const other = lookupReference(rule.other, ctx);
    if (!Array.isArray(other)) return null;
    const values = new Set(
      other
        .filter(isItem)
        .map((o) => o[rule.otherField])
        .filter(scalar),
    );
    return items.map((it) => {
      const has = scalar(it[rule.field]) && values.has(it[rule.field] as never);
      return rule.kind === "in" ? has : !has;
    });
  }
  if (rule.kind === "equals") {
    return items.map((it) => it[rule.field] === rule.value);
  }
  return items.map((it) => {
    const v = it[rule.field];
    if (typeof v !== "number") return false;
    return rule.kind === "negative" ? v < 0 : v > 0;
  });
}

/**
 * Today's selected items: the ones every rule selects. null when the list is
 * gone or a rule cannot be applied (then the old count-based check stays).
 */
export function selectedItems(
  selection: Selection,
  ctx: TemplateContext,
): Item[] | null {
  const list = lookupReference(selection.list, ctx);
  if (!Array.isArray(list) || !list.every(isItem)) return null;
  let keep = list.map(() => true);
  for (const rule of selection.rules) {
    const picks = applyRule(rule, list, ctx);
    if (picks === null) return null;
    keep = keep.map((k, i) => k && picks[i]!);
  }
  return list.filter((_, i) => keep[i]);
}

/** Lists of objects in the recorded results, by template reference. */
function listsIn(node: unknown, at: string, out: Map<string, Item[]>): void {
  if (Array.isArray(node)) {
    if (node.length > 0 && node.every(isItem)) out.set(at, node);
    return;
  }
  if (isItem(node)) {
    for (const [k, v] of Object.entries(node)) listsIn(v, `${at}.${k}`, out);
  }
}

const same = (a: boolean[], b: boolean[]) => a.every((x, i) => x === b[i]);

/**
 * Rules that select exactly `selected` (indices into the list at `list`) from
 * the recorded data. [] when no simple rule does, or the selection is all or
 * none of the items (nothing to learn).
 */
export function learnRules(
  list: string,
  selected: number[],
  ctx: TemplateContext,
): SelectionRule[] {
  const items = lookupReference(list, ctx);
  if (!Array.isArray(items) || !items.every(isItem)) return [];
  const want = items.map((_, i) => selected.includes(i));
  if (want.every(Boolean) || !want.some(Boolean)) return [];
  const fields = [...new Set(items.flatMap((it) => Object.keys(it)))].filter(
    (f) => items.every((it) => scalar(it[f])),
  );
  const rules: SelectionRule[] = [];
  const fits = (rule: SelectionRule) => {
    const got = applyRule(rule, items, ctx);
    return got !== null && same(got, want);
  };

  // membership in another list read in the same run (the ledger)
  const others = new Map<string, Item[]>();
  listsIn(ctx.steps, "steps", others);
  for (const [other, rows] of others) {
    if (other === list || other.startsWith(`${list}.`)) continue;
    const otherFields = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    for (const field of fields) {
      for (const otherField of otherFields) {
        for (const kind of ["notIn", "in"] as const) {
          const rule = { kind, field, other, otherField };
          // a rule that matches nothing in the other list is not a membership rule
          const overlap = items.some((it) =>
            rows.some((r) => r[otherField] === it[field]),
          );
          if (overlap && fits(rule)) rules.push(rule);
        }
      }
    }
  }
  // a category (currency = USD, status = open); the key field names items, it is no category
  for (const field of fields) {
    const values = new Set(items.map((it) => it[field]));
    if (values.size === items.length) continue;
    for (const value of values) {
      const rule = { kind: "equals" as const, field, value: value as string };
      if (fits(rule)) rules.push(rule);
    }
  }
  // the sign of an amount (the outgoing payments)
  for (const field of fields) {
    if (!items.every((it) => typeof it[field] === "number")) continue;
    for (const kind of ["negative", "positive"] as const) {
      const rule = { kind, field };
      if (fits(rule)) rules.push(rule);
    }
  }
  return rules;
}

/**
 * learnRules, also when the text names an item in passing. A report may name
 * an unselected item on a line of its own ("All other lines (BK-1001, …) have
 * a ledger entry"): such an item, named on no line that names another cited
 * item, is a side remark, and the rule is learned without it (measured: a
 * Sonnet recording of the reconciliation did this, and no rule was learned).
 * Only one remark is set aside, and only when the rest then fits exactly.
 */
export function learnRulesFromText(
  list: string,
  picked: number[],
  ctx: TemplateContext,
  example: string,
  key: string,
): { rules: SelectionRule[]; selected: number[] } {
  const exact = learnRules(list, picked, ctx);
  if (exact.length > 0) return { rules: exact, selected: picked };
  const items = lookupReference(list, ctx);
  if (!Array.isArray(items)) return { rules: [], selected: picked };
  const lines = example.split("\n");
  const linesOf = (i: number) => {
    const name = String((items[i] as Item | undefined)?.[key] ?? "");
    return name ? lines.flatMap((l, n) => (l.includes(name) ? [n] : [])) : [];
  };
  // how many items of the list a line names, by key or by the key's number
  // ("BK-1001, 1002, 1003" names three)
  const named = (line: string) =>
    items.filter((it) => {
      const name = String((it as Item)[key] ?? "");
      const digits = /(\d+)$/.exec(name)?.[1];
      return (
        (name !== "" && line.includes(name)) ||
        (digits !== undefined &&
          digits.length >= 3 &&
          new RegExp(`\\b${digits}\\b`).test(line))
      );
    });
  for (const aside of picked) {
    const rest = picked.filter((p) => p !== aside);
    const own = linesOf(aside);
    const shared = rest.some((p) => linesOf(p).some((n) => own.includes(n)));
    if (own.length === 0 || shared || rest.length === 0) continue;
    // a remark about the other items names several of them on one line; one
    // item alone on its line is an entry of the report, never set aside
    const remark = own.every((n) => {
      const names = named(lines[n]!);
      return (
        names.length >= 2 &&
        !names.some((it) => rest.includes(items.indexOf(it)))
      );
    });
    if (!remark) continue;
    const rules = learnRules(list, rest, ctx);
    if (rules.length > 0) return { rules, selected: rest };
  }
  return { rules: [], selected: picked };
}
