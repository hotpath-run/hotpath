import { lookupReference, type TemplateContext } from "./template.js";

// Most of a recorded message is a fixed layout filled with data: one line per
// email, one per event. Those lines need no model: the compiler turns them into
// a row template, and at run time code writes one row per item of today's list.
// The model writes only the rest (task 05).

/** Lines that are one row per item of a list. */
export interface RowGroup {
  /** the line that stands for the rows in the skeleton, e.g. "[[rows:1]]" */
  marker: string;
  /** the list, as a reference without braces: steps.s1.result.emails */
  over: string;
  /** one row; `{{item.<field>}}` is a field of the current item */
  template: string;
}

export interface Layout {
  /** the recorded text with each group of rows replaced by its marker line */
  skeleton: string;
  rows: RowGroup[];
}

const ITEM_REF = /\{\{item((?:\.[^.{}\s]+)*)\}\}/g;

function field(item: unknown, path: string): unknown {
  let value = item;
  for (const key of path.split(".").filter(Boolean)) {
    value =
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
  }
  return value;
}

/** One row for one item; null when a field the row needs is missing. */
export function renderRow(template: string, item: unknown): string | null {
  let ok = true;
  const text = template.replace(ITEM_REF, (_m, path: string) => {
    const value = field(item, path);
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    ok = false;
    return "";
  });
  return ok ? text : null;
}

/**
 * `text` with every marker line replaced by the rows for this run's data (an
 * empty list leaves no line). null when the text cannot be filled: a marker is
 * missing, changed or repeated, a list is no longer a list, or an item lacks a
 * field. The caller then treats the text as a complete one.
 */
export function fillRows(
  text: string,
  rows: RowGroup[],
  ctx: TemplateContext,
): string | null {
  const lines = text.split("\n");
  for (const group of rows) {
    const at = lines
      .map((line, i) => (line.trim() === group.marker ? i : -1))
      .filter((i) => i >= 0);
    if (at.length !== 1) return null;
    const list = lookupReference(group.over, ctx);
    if (!Array.isArray(list)) return null;
    const rendered: string[] = [];
    for (const item of list) {
      const row = renderRow(group.template, item);
      if (row === null) return null;
      rendered.push(row);
    }
    lines.splice(at[0]!, 1, ...rendered);
  }
  // a marker left anywhere (inside a sentence) means the model mangled it
  return lines.some((l) => /\[\[rows:\d+\]\]/.test(l))
    ? null
    : lines.join("\n");
}
