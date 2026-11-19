/** How many list items a value holds, counted through every nesting level. */
export function countItems(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((n, v) => n + 1 + countItems(v), 0);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce<number>((n, v) => n + countItems(v), 0);
  }
  return 0;
}

/**
 * The length limit for a written text. It was set from a recording with
 * `recordedItems` list items; a day with twice the items needs about twice the
 * text, so the limit grows with them and never shrinks below the recorded one.
 */
export function scaledMaxChars(
  maxChars: number,
  recordedItems: number | undefined,
  todayItems: number,
): number {
  if (!recordedItems || todayItems <= recordedItems) return maxChars;
  return Math.ceil((maxChars * todayItems) / recordedItems);
}

/** A read that goes through pages: ask again with `arg` set to the result's `next` until it is empty. */
export interface Paginate {
  arg: string;
  next: string;
  maxPages?: number;
}

export const DEFAULT_MAX_PAGES = 50;

/**
 * Adds a page to what the earlier pages gave: lists are joined, every other
 * field keeps its first value, and the next-page field becomes the new page's.
 */
export function mergePages(acc: unknown, page: unknown, next: string): unknown {
  if (!isRecord(acc) || !isRecord(page)) return acc;
  const out: Record<string, unknown> = { ...acc };
  for (const [k, v] of Object.entries(page)) {
    const have = out[k];
    if (Array.isArray(have) && Array.isArray(v)) out[k] = [...have, ...v];
  }
  out[next] = page[next] ?? null;
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
