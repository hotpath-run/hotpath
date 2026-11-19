// Learns, from one recording, how the agent got each figure it calculated:
// a count, a sum or an average of a field over a list (or over the items it
// selected from that list), optionally converted to the report's currency with
// rates the run read, or one item's converted amount. Only an expression that
// gives exactly the recorded figure is kept; a figure nothing explains stays a
// `derived` line for the model, as before.
import {
  computeFigures,
  isTimestamp,
  isTimeZone,
  itemValue,
  learnRulesFromText,
  localTime,
  maskDatesAndTimes,
  mentions,
  numbersInText,
  parseOffset,
  rateTable,
  round2,
  statesTime,
  type Calculation,
  type Conversion,
  type RateSource,
  type Selection,
  type TemplateContext,
  type TimeShift,
  type Workflow,
} from "@hotpathrun/shared";

import type { RecordedResult } from "./compiler.js";
import { CALCULATED } from "./derived.js";

type Item = Record<string, unknown>;
const isItem = (v: unknown): v is Item =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const CODE = /^[A-Z]{3}$/;
// fields that name an item in a text, best first (same idea as coverage.ts)
const KEYS = ["ref", "id", "number", "name", "title", "subject", "sku", "code"];

function objectLists(node: unknown, at: string, out: Map<string, Item[]>) {
  if (Array.isArray(node)) {
    if (node.length > 0 && node.every(isItem)) out.set(at, node);
    return;
  }
  if (isItem(node)) {
    for (const [k, v] of Object.entries(node))
      objectLists(v, `${at}.${k}`, out);
  }
}

/** Results that hold an exchange rate: {currency: "USD", eur_per_unit: 0.9}, or {USD: 0.9, …}. */
export function findRateSources(
  ctx: TemplateContext,
  exclude: string,
): RateSource[] {
  const out: RateSource[] = [];
  const visit = (node: unknown, at: string) => {
    if (at === exclude || at.startsWith(`${exclude}.`)) return;
    if (Array.isArray(node)) {
      node.forEach((n, i) => visit(n, `${at}.${i}`));
      return;
    }
    if (!isItem(node)) return;
    const entries = Object.entries(node);
    if (
      entries.length > 0 &&
      entries.every(([k, v]) => CODE.test(k) && typeof v === "number")
    ) {
      out.push({ ref: at, map: true });
      return;
    }
    const code = entries.find(([, v]) => typeof v === "string" && CODE.test(v));
    const nums = entries.filter(([, v]) => typeof v === "number");
    const rate =
      nums.find(([k]) => /rate|per|fx/i.test(k)) ??
      (nums.length === 1 ? nums[0] : undefined);
    if (code && rate) {
      out.push({ ref: at, codeField: code[0], rateField: rate[0] });
      return;
    }
    for (const [k, v] of entries) visit(v, `${at}.${k}`);
  };
  visit(ctx.steps, "steps");
  return out;
}

function keyField(items: Item[]): string | null {
  const fields = Object.keys(items[0] ?? {});
  for (const k of KEYS) {
    const f = fields.find((x) => x.toLowerCase() === k);
    if (f && new Set(items.map((i) => i[f])).size === items.length) return f;
  }
  return null;
}

/** The figures in a line that no data holds: what the agent calculated. */
function calculatedIn(line: string, known: Set<number>): number[] {
  // "2) BK-1007 …", "3. Rent": the list's own numbering is no figure
  const body = line.replace(/^\s*\d+[.)]\s/, "");
  return numbersInText(body).filter(
    (n) => !known.has(n) && !known.has(-n) && !known.has(Math.abs(n)),
  );
}

const close = (a: number, b: number) => Math.abs(round2(a) - round2(b)) < 0.005;

/**
 * Calculations for one AI step's recorded text. `ctx` holds the recorded
 * results (steps.<id>.result) and inputs.
 */
export function learnCalculations(
  example: string,
  ctx: TemplateContext,
): Calculation[] {
  const known = new Set<number>();
  const collect = (node: unknown) => {
    if (typeof node === "number") known.add(node);
    else if (Array.isArray(node)) node.forEach(collect);
    else if (isItem(node)) Object.values(node).forEach(collect);
  };
  collect(ctx.steps);
  collect(ctx.inputs);

  const lists = new Map<string, Item[]>();
  objectLists(ctx.steps, "steps", lists);

  // per list: what the text selected from it, and the rule, when one fits
  interface Scope {
    list: string;
    items: Item[];
    key: string;
    selection?: Selection;
  }
  const scopes: Scope[] = [];
  for (const [list, items] of lists) {
    const key = keyField(items);
    if (!key) continue;
    const picked = items
      .map((it, i) => (mentions(example, it[key]) ? i : -1))
      .filter((i) => i >= 0);
    const { rules } =
      picked.length > 0 && picked.length < items.length
        ? learnRulesFromText(list, picked, ctx, example, key)
        : { rules: [] };
    if (rules.length > 0) {
      scopes.push({ list, items, key, selection: { list, key, rules } });
    }
    scopes.push({ list, items, key });
  }

  const out: Calculation[] = [];
  for (const scope of scopes) {
    const calc = learnTime(example, scope, ctx);
    if (calc) {
      out.push(calc);
      break;
    }
  }
  for (const line of example.split("\n")) {
    for (const figure of calculatedIn(line, known)) {
      const calc = explain(line, figure, scopes, ctx);
      if (calc) out.push(calc);
    }
  }
  return out;
}

function explain(
  line: string,
  figure: number,
  scopes: Array<{
    list: string;
    items: Item[];
    key: string;
    selection?: Selection;
  }>,
  ctx: TemplateContext,
): Calculation | null {
  // the token as written (-297.50, 1,234.5): matched by value, not by text
  // (measured: a Sonnet recording wrote "-297.50" and nothing was learned)
  // never inside a date or a clock time: "October 1, 2026" holds no count of 1
  const trimmed = line.trim();
  let template = trimmed;
  for (const m of maskDatesAndTimes(trimmed).matchAll(
    /(?<![\w.-])-?\d[\d,]*(?:\.\d+)?(?![\w-])/g,
  )) {
    if (Number(m[0].replace(/,/g, "")) !== figure) continue;
    template =
      trimmed.slice(0, m.index) +
      CALCULATED +
      trimmed.slice(m.index + m[0].length);
    break;
  }
  // a line still holding the recorded figure must never be shown as today's
  if (!template.includes(CALCULATED)) return null;
  for (const scope of scopes) {
    const fields = Object.keys(scope.items[0]!).filter((f) =>
      scope.items.every((it) => typeof it[f] === "number"),
    );
    const currencyField = Object.keys(scope.items[0]!).find((f) =>
      scope.items.every(
        (it) => typeof it[f] === "string" && CODE.test(it[f] as string),
      ),
    );
    const rates = findRateSources(ctx, scope.list);
    const lineCodes = (line.match(/\b[A-Z]{3}\b/g) ?? []).filter((c) =>
      scope.items.some((it) => currencyField && it[currencyField] === c),
    );
    const conversions: Array<Conversion | undefined> = [undefined];
    if (currencyField && rates.length > 0) {
      const table = rateTable(rates, ctx);
      // the report's currency: named in the line, and no rate is needed for it
      for (const base of [...new Set(lineCodes)].reverse()) {
        if (!table.has(base)) conversions.push({ currencyField, base, rates });
      }
    }
    const base = {
      line: template,
      list: scope.list,
      recorded: figure,
      ...(scope.selection ? { selection: scope.selection } : {}),
    };
    const tries: Calculation[] = [];
    // one item's own converted amount, in the line that names it
    const named = scope.items.filter((it) =>
      line.includes(String(it[scope.key])),
    );
    // only for a selection: "every item converted" is not what a selective text asks for
    if (named.length === 1 && scope.selection) {
      for (const field of fields) {
        for (const convert of conversions) {
          if (!convert) continue;
          const v = itemValue(
            named[0]!,
            field,
            convert,
            rateTable(convert.rates, ctx),
          );
          if (v !== null && close(v, figure)) {
            tries.push({ ...base, op: "each", field, convert, key: scope.key });
          }
        }
      }
    }
    for (const field of fields) {
      for (const convert of conversions) {
        for (const op of ["sum", "avg"] as const) {
          tries.push({ ...base, op, field, ...(convert ? { convert } : {}) });
        }
      }
    }
    tries.push({ ...base, op: "count" });
    // added as is: an item in a currency the recording never saw needs a rate
    const withUnits = (calc: Calculation): Calculation =>
      currencyField && !calc.convert && calc.op !== "count"
        ? {
            ...calc,
            units: {
              field: currencyField,
              seen: [
                ...new Set(scope.items.map((it) => String(it[currencyField]))),
              ],
            },
          }
        : calc;
    for (const calc of tries) {
      if (calc.op === "each") return calc;
      const got = computeFigures(calc, ctx);
      if (got && got.length === 1 && close(got[0]!.value, figure)) {
        return withUnits(calc);
      }
    }
  }
  return null;
}

/** Where the data holds a UTC offset ("+02:00") or a time zone ("Europe/Paris"). */
function timeShifts(ctx: TemplateContext): TimeShift[] {
  const offsets: TimeShift[] = [];
  const zones: TimeShift[] = [];
  const visit = (node: unknown, at: string) => {
    if (typeof node === "string") {
      if (parseOffset(node) !== null) offsets.push({ offsetRef: at });
      else if (isTimeZone(node)) zones.push({ zoneRef: at });
    } else if (isItem(node)) {
      for (const [k, v] of Object.entries(node)) visit(v, `${at}.${k}`);
    }
    // inside lists: an item's own offset is not one shift for every item
  };
  visit(ctx.steps, "steps");
  return [...offsets, ...zones, { utc: true }];
}

const CLOCK = /(?<![\d.:])\d{1,2}[:.]\d{2}(?:\s*[ap]\.?m\b\.?)?(?!\d|:\d)/gi;

/**
 * Local clock times the agent worked out from UTC timestamps ("09:30" for
 * 07:30Z at +02:00): learned when every line that names exactly one item and
 * holds a clock time states that item's local time under one shift the data
 * gives (an offset, then a zone, then UTC as is).
 */
function learnTime(
  example: string,
  scope: { list: string; items: Item[]; key: string; selection?: Selection },
  ctx: TemplateContext,
): Calculation | null {
  const first = scope.items[0]!;
  const field = Object.keys(first).find((f) =>
    scope.items.every((it) => isTimestamp(it[f])),
  );
  if (!field) return null;
  const lines = example
    .split("\n")
    .map((line) => ({
      line,
      named: scope.items.filter((it) => mentions(line, it[scope.key])),
    }))
    .filter(
      (l) => l.named.length === 1 && (l.line.match(CLOCK) ?? []).length > 0,
    );
  if (lines.length === 0) return null;
  const timed = new Set(lines.map((l) => l.named[0]));
  // the text times some items only: code cannot tell which without a rule
  if (!scope.selection && timed.size < scope.items.length) return null;
  for (const shift of timeShifts(ctx)) {
    const fits = lines.every((l) => {
      const time = localTime(l.named[0]![field], shift, ctx);
      return time !== null && statesTime(l.line, time);
    });
    if (!fits) continue;
    const line = lines[0]!.line.trim();
    return {
      line,
      op: "time",
      list: scope.list,
      ...(scope.selection ? { selection: scope.selection } : {}),
      field,
      key: scope.key,
      shift,
      recorded: timed.size,
    };
  }
  return null;
}

/** Sets `calculations` on every AI step whose recorded figures code can recompute. */
export function markCalculations(
  workflow: Workflow,
  recorded: RecordedResult[],
  inputs: Record<string, unknown>,
): Workflow {
  // HOTPATH_CALCULATIONS=0: the model calculates, as before (to measure the difference)
  if (process.env.HOTPATH_CALCULATIONS === "0") return workflow;
  const ctx: TemplateContext = { inputs: inputs as never, steps: {} };
  for (const r of recorded) {
    ctx.steps[r.id] = (
      r.field === "results" ? { results: r.result } : { result: r.result }
    ) as never;
  }
  let changed = false;
  const steps = workflow.steps.map((s) => {
    if (s.type !== "llm") return s;
    const calculations = learnCalculations(s.example, ctx);
    if (calculations.length === 0) return s;
    changed = true;
    return { ...s, calculations };
  });
  return changed ? { ...workflow, steps } : workflow;
}
