// Report figures the plain calculations cannot explain: one figure per group of a
// loop ("NORDICS: 7,650", one line per region read), filtered ("paid orders only"),
// counted by a word ("payments: 7 errors" over log lines), the top item by a summed
// field ("top customer Soylent (4,100)") and totals over every group's items.
// Measured: on the hard bench a free model got every regional total of a sales report
// wrong, adding 20-60 amounts in its head; code computes them instead.
import {
  figureOver,
  listAt,
  passes,
  round2,
  statesFigure,
  type CalcFilter,
  type Calculation,
  type TemplateContext,
} from "@hotpathrun/shared";

import { CALCULATED } from "./derived.js";

type Item = Record<string, unknown>;
const isItem = (v: unknown): v is Item =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A loop's results: one object per group, named by `name`, holding a list at `path`. */
interface GroupSource {
  list: string;
  name: string;
  path: string;
  groups: Item[];
  /** sibling steps' results (get_logs for payments, then search, then auth) */
  refs?: string[];
}

/** name and list fields shared by every result: a string that differs per group, and an array */
function shapes(results: Item[]): Array<{ name: string; path: string }> {
  const first = results[0]!;
  const names = Object.keys(first).filter(
    (k) =>
      results.every((r) => typeof r[k] === "string") &&
      new Set(results.map((r) => r[k])).size === results.length,
  );
  const paths = Object.keys(first).filter((k) =>
    results.every((r) => Array.isArray(r[k])),
  );
  return names.flatMap((name) => paths.map((path) => ({ name, path })));
}

type Candidate = Pick<Calculation, "op" | "field" | "where" | "match" | "by">;

const close = (a: number, b: number) => Math.abs(round2(a) - round2(b)) < 0.005;

const namedIn = (line: string, name: string) =>
  new RegExp(
    `(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
  ).test(line);

export function groupSources(ctx: TemplateContext): GroupSource[] {
  const out: GroupSource[] = [];
  for (const [id, entry] of Object.entries(ctx.steps)) {
    const results = (entry as { results?: unknown } | undefined)?.results;
    if (!Array.isArray(results) || results.length < 2) continue;
    if (!results.every(isItem)) continue;
    for (const { name, path } of shapes(results))
      out.push({ list: `steps.${id}.results`, name, path, groups: results });
  }
  // steps whose results have the same keys: the same tool called once per group
  const byShape = new Map<string, Array<{ ref: string; result: Item }>>();
  for (const [id, entry] of Object.entries(ctx.steps)) {
    const result = (entry as { result?: unknown } | undefined)?.result;
    if (!isItem(result)) continue;
    const key = Object.keys(result).sort().join(",");
    byShape.set(key, [
      ...(byShape.get(key) ?? []),
      { ref: `steps.${id}.result`, result },
    ]);
  }
  for (const same of byShape.values()) {
    if (same.length < 2) continue;
    const results = same.map((s) => s.result);
    const refs = same.map((s) => s.ref);
    for (const { name, path } of shapes(results))
      out.push({ list: refs[0]!, name, path, groups: results, refs });
  }
  return out;
}

/** Every formula worth trying over these items, plain ones first. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** The run's date inputs, as references: what "overdue" compares a due date with. */
function dateRefs(ctx: TemplateContext): string[] {
  return Object.entries(ctx.inputs)
    .filter(([, v]) => typeof v === "string" && ISO_DATE.test(v))
    .map(([k]) => `inputs.${k}`);
}

function candidates(
  items: unknown[],
  withCounts: boolean,
  dates: string[] = [],
): Candidate[] {
  if (items.length === 0) return [];
  if (items.every((x) => typeof x === "string")) {
    const words = new Set<string>();
    for (const line of items as string[])
      for (const w of line.match(/\b[A-Z]{3,}\b/g) ?? []) words.add(w);
    return words.size > 12
      ? []
      : [...words].flatMap((match): Candidate[] => [
          { op: "count", match },
          { op: "top", match },
        ]);
  }
  if (!items.every(isItem)) return [];
  const rows = items as Item[];
  const keys = Object.keys(rows[0]!);
  const numeric = keys.filter((k) =>
    rows.every((r) => typeof r[k] === "number"),
  );
  const strings = keys.filter((k) =>
    rows.every((r) => typeof r[k] === "string"),
  );
  const distinct = (k: string) => [...new Set(rows.map((r) => r[k] as string))];
  // a field with a few values is a status or a kind: a filter
  const filters: CalcFilter[] = strings
    .filter((k) => {
      const n = distinct(k).length;
      return n >= 2 && n <= 5 && n < rows.length;
    })
    .flatMap((k) => [
      ...distinct(k).map((v) => ({ field: k, equals: v })),
      ...distinct(k).map((v) => ({ field: k, not: v })),
    ]);
  // a field with repeated values is something to rank by: customer, product
  const bys = strings.filter((k) => {
    const n = distinct(k).length;
    return n >= 2 && n < rows.length;
  });
  // a date field compared with the run's date: overdue, upcoming
  for (const k of strings) {
    if (!rows.every((r) => ISO_DATE.test(r[k] as string))) continue;
    for (const ref of dates)
      filters.push({ field: k, before: ref }, { field: k, after: ref });
  }
  const wheres: Array<CalcFilter | undefined> = [undefined, ...filters];
  const out: Candidate[] = [];
  for (const where of wheres) {
    if (withCounts) out.push({ op: "count", ...(where ? { where } : {}) });
    for (const field of numeric)
      for (const op of ["sum", "avg"] as const)
        out.push({ op, field, ...(where ? { where } : {}) });
  }
  for (const where of wheres)
    for (const by of bys)
      for (const field of numeric)
        out.push({ op: "top", by, field, ...(where ? { where } : {}) });
  return out;
}

const signature = (values: number[]) => values.map((v) => round2(v)).join(",");

/** The line with the figure as <calculated>, and the decimals it was written with. */
function written(
  line: string,
  figure: number,
): { line: string; decimals?: number } | null {
  const trimmed = line.trim();
  for (const m of trimmed.matchAll(
    /(?<![\w.-])-?\d[\d,]*(?:\.\d+)?(?![\w-])/g,
  )) {
    if (!close(Number(m[0].replace(/,/g, "")), figure)) continue;
    const decimals = /\.(\d+)$/.exec(m[0])?.[1]?.length;
    return {
      line:
        trimmed.slice(0, m.index) +
        CALCULATED +
        trimmed.slice(m.index + m[0].length),
      ...(decimals ? { decimals } : {}),
    };
  }
  return null;
}

export interface GroupLearning {
  calcs: Calculation[];
  /** "<line index>:<figure>" for every figure these formulas explain */
  covered: Set<string>;
}

/**
 * Formulas that give, for every group of a loop, a figure its own line states. A
 * formula is kept only when it fits at least two groups and every group has its
 * line: one region explained by chance is no rule.
 */
export function learnGroupCalculations(
  example: string,
  ctx: TemplateContext,
  plainLists: string[] = [],
): GroupLearning {
  // a group's row is a sentence, not only a line: an agent may write every
  // service in one paragraph ("payments — 15 ERROR lines; … search — 19 …")
  const bySentence = learnWithRows(example, ctx, plainLists, SENTENCE);
  // …or a clause, when one sentence holds them all ("enterprise = 9, mid = 9,
  // smb = 6"): tried second, for the formulas the sentences did not give
  const byClause = learnWithRows(example, ctx, plainLists, CLAUSE);
  const same = (c: Calculation) =>
    JSON.stringify([
      c.op,
      c.list,
      c.group,
      c.per,
      c.where,
      c.field,
      c.by,
      c.match,
    ]);
  const have = new Set(bySentence.calcs.map(same));
  return {
    calcs: [
      ...bySentence.calcs,
      ...byClause.calcs.filter((c) => !have.has(same(c))),
    ],
    covered: new Set([...bySentence.covered, ...byClause.covered]),
  };
}

const SENTENCE = /(?<=[.;])\s+(?=\S)/;
// a comma then a space: "38,338" stays one number
const CLAUSE = /(?<=[.;,])\s+(?=\S)/;

function learnWithRows(
  example: string,
  ctx: TemplateContext,
  plainLists: string[],
  split: RegExp,
): GroupLearning {
  const lines = example
    .split("\n")
    .flatMap((text, line) =>
      text.split(split).map((part) => ({ text: part, line })),
    );
  const at2line = (i: number) => lines[i]!.line;
  const calcs: Calculation[] = [];
  const covered = new Set<string>();
  const dates = dateRefs(ctx);
  // a group's row: the first sentence naming it with a figure ("Best region:
  // NA" later names a group too, but the rows come first)
  const rowOf = (name: string) =>
    lines.findIndex((l) => namedIn(l.text, name) && /\d/.test(l.text));
  // a row with the rest of its line, up to the next group's row: the most
  // frequent message is often its own sentence ("…; most frequent: …")
  const rowText = (i: number, at: number[]) => {
    const parts = [lines[i]!.text];
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k]!.line !== lines[i]!.line || at.includes(k)) break;
      parts.push(lines[k]!.text);
    }
    return parts.join(" ");
  };
  const fitsRows = (
    got: Array<{ value: number; name?: string }>,
    at: number[],
    op: string,
    whole = false,
  ) =>
    got.every((x, i) => {
      const line = whole ? rowText(at[i]!, at) : lines[at[i]!]!.text;
      return (
        statesFigure(line, x.value) && (op !== "top" || namedIn(line, x.name!))
      );
    }) &&
    // a count of 0 or 1 everywhere, or the same figure in every group, says nothing
    new Set(got.map((x) => x.value)).size > 1 &&
    !got.every((x) => Math.abs(x.value) < 2);
  for (const source of groupSources(ctx)) {
    const at = source.groups.map((g) => rowOf(g[source.name] as string));
    if (at.some((i) => i < 0) || new Set(at).size !== at.length) continue;
    const all = source.groups.flatMap((g) => g[source.path] as unknown[]);
    const seen = new Set<string>();
    for (const cand of candidates(all, true, dates)) {
      const got = source.groups.map((g) =>
        figureOver(cand, g[source.path] as unknown[], ctx),
      );
      if (got.some((x) => x === null)) continue;
      const values = got.map((x) => x!.value);
      const sig = `${cand.op}:${signature(values)}`;
      if (seen.has(sig)) continue;
      // a top item is often its own clause ("revenue 38,338; top customer Soylent (8,910)")
      const whole = cand.op === "top";
      if (!fitsRows(got as Array<{ value: number }>, at, cand.op, whole))
        continue;
      seen.add(sig);
      const w = written(
        whole ? rowText(at[0]!, at) : lines[at[0]!]!.text,
        values[0]!,
      );
      if (!w) continue;
      calcs.push({
        ...cand,
        ...w,
        list: source.list,
        group: {
          name: source.name,
          path: source.path,
          ...(source.refs ? { refs: source.refs } : {}),
        },
        recorded: values[0]!,
      });
      values.forEach((v, i) => covered.add(`${at2line(at[i]!)}:${round2(v)}`));
    }
  }
  // one figure per value of a field in one list (per vendor): the values the
  // filter keeps are the groups, each with its row in the text
  for (const ref of plainLists) {
    const items = listAt(ref, ctx);
    if (!items || items.length < 3 || !items.every(isItem)) continue;
    const rows = items as Item[];
    const fields = Object.keys(rows[0]!).filter((k) => {
      if (!rows.every((r) => typeof r[k] === "string")) return false;
      const n = new Set(rows.map((r) => r[k])).size;
      return n >= 2 && n <= 30 && n < rows.length;
    });
    for (const per of fields) {
      const seen = new Set<string>();
      for (const cand of candidates(rows, true, dates)) {
        if (cand.op === "top") continue;
        const kept = rows.filter((r) => passes(r, cand.where, ctx));
        const groups = new Map<string, Item[]>();
        for (const r of kept) {
          const name = r[per] as string;
          groups.set(name, [...(groups.get(name) ?? []), r]);
        }
        if (groups.size < 2) continue;
        const names = [...groups.keys()];
        const at = names.map(rowOf);
        if (at.some((i) => i < 0) || new Set(at).size !== at.length) continue;
        const got = names.map((n) =>
          figureOver({ ...cand, where: undefined }, groups.get(n)!, ctx),
        );
        if (got.some((x) => x === null)) continue;
        const values = got.map((x) => x!.value);
        const sig = `${cand.op}:${signature(values)}`;
        if (seen.has(sig)) continue;
        if (!fitsRows(got as Array<{ value: number }>, at, cand.op)) continue;
        // the text lists exactly these groups: none the filter left out
        const left = new Set(rows.map((r) => r[per] as string));
        for (const n of names) left.delete(n);
        if ([...left].some((n) => rowOf(n) >= 0)) continue;
        seen.add(sig);
        const w = written(lines[at[0]!]!.text, values[0]!);
        if (!w) continue;
        calcs.push({ ...cand, ...w, list: ref, per, recorded: values[0]! });
        values.forEach((v, i) =>
          covered.add(`${at2line(at[i]!)}:${round2(v)}`),
        );
      }
    }
  }
  return { calcs, covered };
}

/**
 * A figure over every group's items put together (a total across regions), or a
 * filtered sum over one list: tried after the plain formulas found nothing.
 */
export function explainAcross(
  line: string,
  figure: number,
  ctx: TemplateContext,
  plainLists: string[],
): Calculation | null {
  const refs = [
    // (sibling steps have no one list to put together: their totals stay with the model)
    ...groupSources(ctx)
      .filter((s) => !s.refs)
      .map((s) => ({
        ref: `${s.list}.*.${s.path}`,
        counts: true,
      })),
    // one list: only filtered amounts (a filtered count matches small numbers by chance)
    ...plainLists.map((ref) => ({ ref, counts: false })),
  ];
  const done = new Set<string>();
  for (const { ref, counts } of refs) {
    if (done.has(ref)) continue;
    done.add(ref);
    const items = listAt(ref, ctx);
    if (!items) continue;
    for (const cand of candidates(items, counts, dateRefs(ctx))) {
      if (!counts && !cand.where && cand.op !== "top") continue;
      const got = figureOver(cand, items, ctx);
      if (!got || !close(got.value, figure)) continue;
      if (cand.op === "top" && !namedIn(line, got.name!)) continue;
      const w = written(line, figure);
      if (!w) return null;
      return { ...cand, ...w, list: ref, recorded: figure };
    }
  }
  return null;
}
