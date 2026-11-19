// Run-time checks that use what the compiler learned about a recording: which
// items it selected (selection rules) and how it calculated its figures
// (calculations). Both are computed on THIS run's data.
import {
  computeFigures,
  formatFigure,
  lookupReference,
  mentions,
  numbersInText,
  selectedItems,
  statesFigure,
  statesTime,
  type Calculation,
  type Figure,
  type GroundingEntry,
  type SelectionRule,
  type TemplateContext,
} from "@hotpathrun/shared";

type Item = Record<string, unknown>;

/**
 * For a `positions` entry with a selection rule: today's selected items that
 * the text does not cite (by any of the entry's fields), named by their key.
 * null when the rule cannot be applied today (the caller keeps the count check).
 */
export function selectionMissing(
  entry: GroundingEntry,
  ctx: TemplateContext,
  text: string,
): string[] | null {
  if (!entry.select) return null;
  const items = selectedItems(entry.select, ctx);
  if (items === null) return null;
  const list = entry.select.list;
  const all = entry.paths.map((p) => p.slice(list.length + 3));
  // by its key (the ref the recording named it by): an amount or a word of the
  // description alone can belong to another line (-95 EUR next to BK-2003)
  const fields = all.includes(entry.select.key) ? [entry.select.key] : all;
  const cited = (item: Item) =>
    fields.some((f) => {
      const v = f
        .split(".")
        .filter(Boolean)
        .reduce<unknown>(
          (node, k) =>
            node !== null && typeof node === "object"
              ? (node as Item)[k]
              : undefined,
          item,
        );
      const usable =
        (typeof v === "string" && v.trim().length > 0) ||
        (typeof v === "number" && Number.isFinite(v));
      return usable && mentions(text, v);
    });
  return items
    .filter((item) => !cited(item))
    .map((item) => String(item[entry.select!.key]));
}

function ruleText(rule: SelectionRule): string {
  const where = (ref: string) =>
    ref.replace(/^steps\./, "").replace(/\.result$/, "");
  switch (rule.kind) {
    case "notIn":
      return `${rule.field} not found in ${where(rule.other)} (${rule.otherField})`;
    case "in":
      return `${rule.field} found in ${where(rule.other)} (${rule.otherField})`;
    case "equals":
      return `${rule.field} = ${JSON.stringify(rule.value)}`;
    case "negative":
      return `${rule.field} below 0`;
    case "positive":
      return `${rule.field} above 0`;
  }
}

/**
 * Lines for the prompt: which items today's data selects, by the rule the
 * recording followed. Code decides the selection; the model writes about it.
 */
export function selectionHints(
  grounding: GroundingEntry[] | undefined,
  ctx: TemplateContext,
): string[] {
  const out: string[] = [];
  for (const entry of grounding ?? []) {
    if (!entry.select) continue;
    const items = selectedItems(entry.select, ctx);
    if (items === null) continue;
    const keys = items.map((i) => String(i[entry.select!.key]));
    const rule = entry.select.rules.map(ruleText).join(" and ");
    out.push(
      keys.length === 0
        ? `No item of ${entry.select.list.replace(/^steps\./, "")} is selected today (${rule}): say so.`
        : `The items to report today are exactly: ${keys.join(", ")} (the ones with ${rule}).`,
    );
  }
  return out;
}

export interface TodayFigure extends Figure {
  calc: Calculation;
}

/** Today's figures for every calculation that can be computed on this data. */
export function todaysFigures(
  calcs: Calculation[] | undefined,
  ctx: TemplateContext,
): TodayFigure[] {
  const out: TodayFigure[] = [];
  for (const calc of calcs ?? []) {
    for (const f of computeFigures(calc, ctx) ?? []) out.push({ ...f, calc });
  }
  return out;
}

/** The prompt block that hands the model figures computed by code. */
export function figuresPrompt(figures: TodayFigure[]): string {
  if (figures.length === 0) return "";
  return (
    "These figures were calculated by code from the data above. Use them exactly as written, " +
    "do not recalculate them, and do not leave any out:\n" +
    figures.map((f) => `  ${f.text}`).join("\n")
  );
}

/**
 * What the text gets wrong about the figures: ones it does not state, and the
 * recorded figure stated although today's differs (copied from the example).
 */
export function figureProblems(
  figures: TodayFigure[],
  ctx: TemplateContext,
  text: string,
): { missing: string[]; stale: string[] } {
  const missing = figures
    .filter((f) =>
      f.time !== undefined
        ? !statesTime(text, f.time)
        : !statesFigure(text, f.value),
    )
    .map((f) => f.time ?? formatFigure(f.value));
  const inData = new Set<number>();
  const visit = (n: unknown) => {
    if (typeof n === "number") inData.add(Math.abs(n));
    else if (Array.isArray(n)) n.forEach(visit);
    else if (n !== null && typeof n === "object")
      Object.values(n).forEach(visit);
  };
  visit(ctx.steps);
  const today = new Set(figures.map((f) => Math.abs(f.value)));
  const stale = [
    ...new Set(
      figures
        // a clock time is no amount: the example's times are caught as copied facts
        .filter((f) => f.time === undefined)
        .map((f) => f.calc.recorded)
        .filter(
          (r) =>
            // a small whole number ("2 orders") turns up in correct texts for
            // other reasons: like grounding, only distinctive figures count
            (!Number.isInteger(r) || Math.abs(r) >= 10) &&
            !today.has(Math.abs(r)) &&
            !inData.has(Math.abs(r)) &&
            numbersInText(text).some(
              (n) => Math.abs(Math.abs(n) - Math.abs(r)) < 0.005,
            ),
        )
        .map(formatFigure),
    ),
  ];
  return { missing: [...new Set(missing)], stale };
}

/**
 * Lists the AI step writes about (its calculations and the item fields it is
 * grounded on) that are empty today. The recording had items in them, so it
 * never showed what to write on an empty day ("no invoices", or a stale
 * report?): the caller treats it as drift and the agent's recording teaches it.
 */
export function emptyLists(
  calcs: Calculation[] | undefined,
  grounding: GroundingEntry[] | undefined,
  ctx: TemplateContext,
): string[] {
  const refs = new Set<string>();
  for (const c of calcs ?? []) refs.add(c.list);
  for (const entry of grounding ?? []) {
    // a selection may be empty on a normal day; the hint says so
    if (entry.select) continue;
    for (const p of entry.paths) {
      const at = p.indexOf(".*");
      if (at > 0) refs.add(p.slice(0, at));
    }
  }
  return [...refs].filter((ref) => {
    const node = lookupReference(ref, ctx);
    return Array.isArray(node) && node.length === 0;
  });
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;

/**
 * Links and email addresses in the text that are in none of the run's data
 * and not in the recorded example (security finding 5): the usual shape of a
 * prompt injection that makes the text carry data somewhere else
 * ("…see https://evil.example/?q=<the figures>"). A link that is in the data
 * is allowed: the guard cannot tell a tool's own link from a planted one.
 */
export function foreignAddresses(
  text: string,
  ctx: TemplateContext,
  example: string,
): string[] {
  const known =
    `${JSON.stringify([ctx.inputs, ctx.steps])}\n${example}`.toLowerCase();
  const found = [...(text.match(URL_RE) ?? []), ...(text.match(EMAIL_RE) ?? [])]
    .map((a) => a.replace(/[.,;:!?]+$/, ""))
    .filter((a) => !known.includes(a.toLowerCase()));
  return [...new Set(found)];
}
