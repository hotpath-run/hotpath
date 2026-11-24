// Learns a small rulebook for per-item choices (see shared/table.ts) from the
// recorded items: split on a field named like a category (category, priority,
// status…) or on a number, until every group got the same action with values that
// are fixed words or copied from the item. A split on any other text field is never
// tried: a ticket's body that happened to differ per action is no rule.
import type { ItemDecision, TableNode } from "@hotpathrun/shared";

import { byRoundness } from "./rules.js";

type Example = ItemDecision["examples"][number];
type Item = Record<string, unknown>;
const isItem = (v: unknown): v is Item =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// the same names the branch rules trust from one recording per path
const CATEGORY_LIKE =
  /(^|_)(category|priority|status|kind|type|tier|level|severity|stage|plan|label|channel|reason|segment|state)($|_)/i;

const MAX_DEPTH = 3;

type From = "item" | "details";
const sourceOf = (e: Example, from: From): unknown =>
  from === "item" ? e.item : e.details;

/** top-level keys whose value is of this kind in every example */
function keys(exs: Example[], from: From, kind: "string" | "number"): string[] {
  const first = sourceOf(exs[0]!, from);
  if (!isItem(first)) return [];
  return Object.keys(first).filter((k) =>
    exs.every((e) => {
      const s = sourceOf(e, from);
      return isItem(s) && typeof s[k] === kind;
    }),
  );
}

/** One action for every example, each value a fixed word or copied from the item. */
function leafOf(exs: Example[], decide: ItemDecision): TableNode | null {
  const action = exs[0]!.choice.action;
  if (typeof action !== "string") return null;
  if (!exs.every((e) => e.choice.action === action)) return null;
  const spec = decide.actions.find((a) => a.tool === action);
  const values: Record<
    string,
    { const: string | number } | { from: From; path: string[] }
  > = {};
  for (const [field, type] of Object.entries(spec?.fields ?? {})) {
    const vals = exs.map((e) => e.choice[field]);
    if (vals.some((v) => typeof v !== type)) return null;
    const same = vals.every((v) => v === vals[0]);
    const copied = (["details", "item"] as const).flatMap((from) =>
      keys(exs, from, type as "string" | "number")
        .filter((k) =>
          exs.every((e) => (sourceOf(e, from) as Item)[k] === e.choice[field]),
        )
        .map((k) => ({ from, path: [k] })),
    );
    if (type === "number") {
      // an amount is the item's own (a refund of what was billed); a fixed
      // number is believed only when two items got it
      if (copied.length > 0) values[field] = copied[0]!;
      else if (same && exs.length >= 2)
        values[field] = { const: vals[0] as number };
      else return null;
    } else if (same) values[field] = { const: vals[0] as string };
    else if (copied.length > 0) values[field] = copied[0]!;
    else return null;
  }
  return { leaf: { action, values } };
}

const size = (n: TableNode): number =>
  "leaf" in n
    ? 1
    : "cases" in n
      ? Object.values(n.cases).reduce((a, c) => a + size(c), 0)
      : n.bands.reduce((a, b) => a + size(b.node), 0);

/** Bands over a number: runs of examples, in its order, that each make one leaf. */
function numberSplit(
  exs: Example[],
  decide: ItemDecision,
  from: From,
  key: string,
  written: number[],
): TableNode | null {
  const num = (e: Example) => (sourceOf(e, from) as Item)[key] as number;
  const sorted = [...exs].sort((a, b) => num(a) - num(b));
  const runs: Example[][] = [];
  for (const e of sorted) {
    const last = runs[runs.length - 1];
    if (last && leafOf([...last, e], decide)) last.push(e);
    else if (last && num(last[last.length - 1]!) === num(e)) return null;
    else runs.push([e]);
  }
  if (runs.length < 2) return null;
  const leaves = runs.map((r) => leafOf(r, decide));
  if (leaves.some((l) => l === null)) return null;
  let closed = 0;
  const cuts = runs.slice(1).map((hi, i) => {
    const lo = Math.max(...runs[i]!.map(num));
    const up = Math.min(...hi.map(num));
    const adjacent =
      Number.isInteger(lo) && Number.isInteger(up) && up - lo === 1;
    const cut = adjacent
      ? up
      : byRoundness(written.filter((w) => w > lo && w <= up))[0];
    if (cut !== undefined) closed++;
    return { lo, up, cut };
  });
  // a line through few items by chance is no rule (see learnBands)
  if (closed === 0 && runs.some((r) => r.length < 3)) return null;
  return {
    from,
    path: [key],
    bands: runs.map((_, i) => {
      const below = cuts[i - 1];
      const above = cuts[i];
      return {
        ...(below ? { gte: below.cut ?? below.up } : {}),
        ...(above
          ? above.cut !== undefined
            ? { lt: above.cut }
            : { lte: above.lo }
          : {}),
        node: leaves[i]!,
      };
    }),
  };
}

function learn(
  exs: Example[],
  decide: ItemDecision,
  written: number[],
  depth: number,
): TableNode | null {
  const leaf = leafOf(exs, decide);
  if (leaf) return leaf;
  if (depth >= MAX_DEPTH || exs.length < 2) return null;
  const found: TableNode[] = [];
  for (const from of ["details", "item"] as const) {
    for (const key of keys(exs, from, "string")) {
      if (!CATEGORY_LIKE.test(key)) continue;
      const groups = new Map<string, Example[]>();
      for (const e of exs) {
        const v = (sourceOf(e, from) as Item)[key] as string;
        groups.set(v, [...(groups.get(v) ?? []), e]);
      }
      if (groups.size < 2 || groups.size > 12) continue;
      const cases: Record<string, TableNode> = {};
      let ok = true;
      for (const [v, g] of groups) {
        const child = learn(g, decide, written, depth + 1);
        if (!child) {
          ok = false;
          break;
        }
        cases[v] = child;
      }
      if (ok) found.push({ from, path: [key], cases });
    }
    for (const key of keys(exs, from, "number")) {
      const split = numberSplit(exs, decide, from, key, written);
      if (split) found.push(split);
    }
  }
  if (found.length === 0) return null;
  // the smallest rulebook that explains every recorded choice
  return found.sort((a, b) => size(a) - size(b))[0]!;
}

/** The table for a loop's choices, or null when none explains every recorded one. */
export function learnTable(
  decide: ItemDecision,
  written: number[],
): TableNode | null {
  if (decide.examples.length < 4) return null;
  const table = learn(decide.examples, decide, written, 0);
  // one action for everything is no decision worth a table
  return table && !("leaf" in table) ? table : null;
}
