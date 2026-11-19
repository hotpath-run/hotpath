// Figures the agent calculated (a total, a count, an amount converted to the
// report's currency), recomputed by code on each run's data. The model is
// given the result instead of doing the arithmetic, and the output is checked
// for it: a wrong sum in a finance report is the worst failure a replay can
// have, and small models copy the recorded total (measured: qwen3:1.7b wrote
// the recorded -297.5 in 20 of 20 bank-reconciliation replays).
import { z } from "zod";

import { selectedItems, selectionSchema } from "./selection.js";
import { lookupReference, type TemplateContext } from "./template.js";

/** Where exchange rates are read from: an object {code, rate} or a map {USD: 0.9}. */
export const rateSourceSchema = z.union([
  z.object({ ref: z.string(), codeField: z.string(), rateField: z.string() }),
  z.object({ ref: z.string(), map: z.literal(true) }),
]);
export type RateSource = z.infer<typeof rateSourceSchema>;

export const conversionSchema = z.object({
  /** the item field that holds its currency */
  currencyField: z.string(),
  /** the report's currency: its items count at rate 1 */
  base: z.string(),
  rates: z.array(rateSourceSchema).min(1),
});
export type Conversion = z.infer<typeof conversionSchema>;

/**
 * How a `time` calculation turns a UTC timestamp into the report's clock time:
 * by an offset the data holds ("+02:00"), a time zone it names
 * ("Europe/Paris"), or none (the times are UTC).
 */
export const timeShiftSchema = z.union([
  z.object({ offsetRef: z.string() }),
  z.object({ zoneRef: z.string() }),
  z.object({ utc: z.literal(true) }),
]);
export type TimeShift = z.infer<typeof timeShiftSchema>;

export const calculationSchema = z.object({
  /** the recorded line with the figure as <calculated> */
  line: z.string(),
  op: z.enum(["count", "sum", "avg", "each", "time"]),
  /** the items: a whole list, or the selected ones */
  list: z.string(),
  selection: selectionSchema.optional(),
  /** numeric item field (not for count) */
  field: z.string().optional(),
  convert: conversionSchema.optional(),
  /** `each`: the field that names the item in its line */
  key: z.string().optional(),
  /** `time`: how to turn the item's UTC timestamp (`field`) into local time */
  shift: timeShiftSchema.optional(),
  /**
   * Added without conversion: the currency codes the recording's items had.
   * An item in another currency cannot be added in (it needs a rate).
   */
  units: z.object({ field: z.string(), seen: z.array(z.string()) }).optional(),
  /** the figure in the recorded text, for the stale check (`time`: how many items it timed) */
  recorded: z.number(),
});
export type Calculation = z.infer<typeof calculationSchema>;

type Item = Record<string, unknown>;
const isItem = (v: unknown): v is Item =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export const round2 = (x: number): number => Math.round(x * 100) / 100;

/** -428 → "-428", -85.5 → "-85.5", 1234.5 → "1234.5" (no grouping: easy to match). */
export const formatFigure = (x: number): string => String(round2(x));

/** code → rate from the run's data; codes not found are absent. */
export function rateTable(
  sources: RateSource[],
  ctx: TemplateContext,
): Map<string, number> {
  const table = new Map<string, number>();
  for (const src of sources) {
    const node = lookupReference(src.ref, ctx);
    if ("map" in src) {
      if (!isItem(node)) continue;
      for (const [code, rate] of Object.entries(node)) {
        if (typeof rate === "number" && Number.isFinite(rate)) {
          table.set(code, rate);
        }
      }
      continue;
    }
    const rows = Array.isArray(node) ? node : [node];
    for (const row of rows) {
      if (!isItem(row)) continue;
      const code = row[src.codeField];
      const rate = row[src.rateField];
      if (typeof code === "string" && typeof rate === "number") {
        table.set(code, rate);
      }
    }
  }
  return table;
}

/** One item's value, converted when asked; null when a rate is missing. */
export function itemValue(
  item: Item,
  field: string,
  convert: Conversion | undefined,
  rates: Map<string, number>,
): number | null {
  const v = item[field];
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (!convert) return v;
  const code = item[convert.currencyField];
  if (code === convert.base) return v;
  const rate = typeof code === "string" ? rates.get(code) : undefined;
  return rate === undefined ? null : v * rate;
}

export interface Figure {
  /** the line to show the model, with today's figure in it */
  text: string;
  value: number;
  /** `time` figures: the clock time "HH:MM" the text must state */
  time?: string;
}

const OFFSET = /^([+-])(\d{2}):?(\d{2})$/;
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** "+02:00" → 120, "-0530" → -330; null for anything else. */
export function parseOffset(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = OFFSET.exec(v.trim());
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

/** An IANA zone name the runtime knows ("Europe/Paris"). */
export function isTimeZone(v: unknown): v is string {
  if (typeof v !== "string" || !/^[A-Za-z_]+\/[A-Za-z_/+-]+$/.test(v)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

/** A timestamp with its zone ("2026-10-01T13:00:00Z"): an instant, not a local time. */
export function isTimestamp(v: unknown): v is string {
  return (
    typeof v === "string" && TIMESTAMP.test(v) && !Number.isNaN(Date.parse(v))
  );
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** The clock time "HH:MM" of a timestamp under a shift; null when it cannot be worked out. */
export function localTime(
  stamp: unknown,
  shift: TimeShift,
  ctx: TemplateContext,
): string | null {
  if (!isTimestamp(stamp)) return null;
  const ms = Date.parse(stamp);
  if ("zoneRef" in shift) {
    const zone = lookupReference(shift.zoneRef, ctx);
    if (!isTimeZone(zone)) return null;
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const h = parts.find((p) => p.type === "hour")?.value;
    const m = parts.find((p) => p.type === "minute")?.value;
    return h && m ? `${h}:${m}` : null;
  }
  const offset =
    "offsetRef" in shift
      ? parseOffset(lookupReference(shift.offsetRef, ctx))
      : 0;
  if (offset === null) return null;
  const local = new Date(ms + offset * 60_000);
  return hhmm(local.getUTCHours() * 60 + local.getUTCMinutes());
}

/** "15:00" → 900. */
export function timeMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Does the text state this clock time? "09:30", "9:30", "9.30" and the
 * 12-hour "9:30 AM" / "3 PM" all count; "19:30" does not count for 9:30.
 */
export function statesTime(text: string, time: string): boolean {
  const minutes = timeMinutes(time);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const re =
    /(?<![\d:.])(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*([ap]\.?m\b\.?)?(?!\d)/gi;
  for (const match of text.matchAll(re)) {
    const hour = Number(match[1]);
    const min = match[2] === undefined ? null : Number(match[2]);
    const ampm = match[3]?.toLowerCase().replace(/\./g, "");
    if (!ampm) {
      if (min !== null && hour === h && min === m) return true;
      continue;
    }
    if (hour < 1 || hour > 12) continue;
    const h24 = (hour % 12) + (ampm === "pm" ? 12 : 0);
    if (h24 === h && (min ?? 0) === m) return true;
  }
  return false;
}

/**
 * Today's figures for one calculation. null when it cannot be computed on this
 * data (a rate was not read, the list is gone): then nothing is claimed and the
 * model writes the line as before.
 */
export function computeFigures(
  calc: Calculation,
  ctx: TemplateContext,
): Figure[] | null {
  const items = calc.selection
    ? selectedItems(calc.selection, ctx)
    : (() => {
        const list = lookupReference(calc.list, ctx);
        return Array.isArray(list) && list.every(isItem) ? list : null;
      })();
  if (items === null) return null;
  const fill = (x: number, line = calc.line) =>
    line.replace("<calculated>", formatFigure(x));
  if (calc.op === "time") {
    if (!calc.field || !calc.key || !calc.shift) return null;
    const out: Figure[] = [];
    for (const item of items) {
      const time = localTime(item[calc.field], calc.shift, ctx);
      if (time === null) return null;
      out.push({
        text: `${String(item[calc.key])}: ${time}`,
        value: timeMinutes(time),
        time,
      });
    }
    return out;
  }
  if (calc.op === "count") {
    return [{ text: fill(items.length), value: items.length }];
  }
  if (!calc.field) return null;
  const rates = calc.convert ? rateTable(calc.convert.rates, ctx) : new Map();
  const values: number[] = [];
  for (const item of items) {
    const v = itemValue(item, calc.field, calc.convert, rates);
    if (v === null) return null;
    values.push(v);
  }
  if (calc.op === "each") {
    if (!calc.key) return null;
    return items.map((item, i) => ({
      text: `${String(item[calc.key!])}: ${formatFigure(values[i]!)}${calc.convert ? ` ${calc.convert.base}` : ""}`,
      value: round2(values[i]!),
    }));
  }
  const sum = values.reduce((a, b) => a + b, 0);
  const value =
    calc.op === "sum" ? sum : values.length === 0 ? 0 : sum / values.length;
  return [{ text: fill(value), value: round2(value) }];
}

// not inside an identifier (BK-1004) or a version (v14.2)
const NUMBER_TOKEN = /(?<![\w.-])-?\d[\d,]*(?:\.\d+)?(?![\w-])/g;

const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
// ISO dates and timestamps, "October 1, 2026", "1 Oct 2026", "Oct 2026" and
// clock times ("15:00", "9:30 am") hold no figure. Measured: "the report for
// October 1, 2026" was learned as a count of 1, and "15:00" read as 15.
const DATE_AND_TIME = new RegExp(
  [
    String.raw`\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?`,
    String.raw`\b${MONTH}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?(?![\d,.]*\d)`,
    String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}\b\.?(?:,?\s+\d{4})?`,
    String.raw`\b${MONTH}\.?\s+\d{4}\b`,
    String.raw`(?<![\d.:])\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\b\.?)?(?!\d|:\d)`,
  ].join("|"),
  "gi",
);

/** Where dates and clock times are in a text, as [start, end) spans. */
export function dateAndTimeSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(DATE_AND_TIME)].map((m) => [
    m.index,
    m.index + m[0].length,
  ]);
}

/** The text with every date and clock time blanked out (same length). */
export function maskDatesAndTimes(text: string): string {
  return text.replace(DATE_AND_TIME, (m) => " ".repeat(m.length));
}

/** Numbers written in a text ("1,234.50" → 1234.5); dates, times and ids excluded. */
export function numbersInText(text: string): number[] {
  const withoutDates = maskDatesAndTimes(text);
  return (withoutDates.match(NUMBER_TOKEN) ?? [])
    .map((t) => Number(t.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}

/**
 * Does the text state this figure? The sign may be written in words
 * ("an outflow of 428 EUR"), and trailing zeros vary ("428.00"), so the
 * magnitude is compared to the cent.
 */
export function statesFigure(text: string, value: number): boolean {
  const want = Math.abs(round2(value));
  return numbersInText(text).some((n) => Math.abs(Math.abs(n) - want) < 0.005);
}

/**
 * Currencies of today's items that a calculation needs and no rate read in
 * this run covers (a currency the recording never saw). A correct figure
 * cannot be written from the data the workflow reads, so the run must not
 * guess: the caller treats it as drift. [] when nothing is missing.
 */
/**
 * Currency codes in today's items that a figure added up without conversion
 * and the recording never saw ("EUR" among "USD" invoices): adding them as is
 * gives a wrong total, so the caller treats it as drift. [] when none.
 */
export function unseenUnits(calc: Calculation, ctx: TemplateContext): string[] {
  if (!calc.units || calc.op === "count") return [];
  const items = calc.selection
    ? selectedItems(calc.selection, ctx)
    : (() => {
        const list = lookupReference(calc.list, ctx);
        return Array.isArray(list) && list.every(isItem) ? list : null;
      })();
  if (items === null) return [];
  const seen = new Set(calc.units.seen);
  const out = new Set<string>();
  for (const item of items) {
    const code = item[calc.units.field];
    if (typeof code === "string" && !seen.has(code)) out.add(code);
  }
  return [...out];
}

export function missingRates(
  calc: Calculation,
  ctx: TemplateContext,
): string[] {
  if (!calc.convert || calc.op === "count") return [];
  const items = calc.selection
    ? selectedItems(calc.selection, ctx)
    : (() => {
        const list = lookupReference(calc.list, ctx);
        return Array.isArray(list) && list.every(isItem) ? list : null;
      })();
  if (items === null) return [];
  const rates = rateTable(calc.convert.rates, ctx);
  const missing = new Set<string>();
  for (const item of items) {
    const code = item[calc.convert.currencyField];
    if (
      typeof code === "string" &&
      code !== calc.convert.base &&
      !rates.has(code)
    ) {
      missing.add(code);
    }
  }
  return [...missing];
}
