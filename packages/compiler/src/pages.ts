import { mergePages, type Paginate } from "@hotpathrun/shared";

interface PageCall {
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Calls to one read-only tool that differ only in a page number that goes up
 * by one, where each page's result names the next page and the last names
 * none, are one paginated read: "keep asking until there is no next page".
 * They become one call at the first page's place, whose result is every page
 * merged, so the rest of the compiler sees the shape a one-page answer has.
 * Other reads may sit between two pages (agents often fetch page 2 after
 * looking at something else); a call with a side effect between them breaks
 * the chain. Anything less certain (a gap, a page that does not name the next
 * one, a run that stops early) is left as the fixed calls the agent made.
 */
export function collapsePages<T extends PageCall>(
  calls: T[],
  isReadOnly: (tool: string) => boolean,
): { calls: T[]; paginate: Map<T, Paginate> } {
  const out: T[] = [];
  const paginate = new Map<T, Paginate>();
  const taken = new Set<number>();
  for (let i = 0; i < calls.length; i++) {
    if (taken.has(i)) continue;
    const chain = pageChain(calls, i, isReadOnly, taken);
    if (!chain) {
      out.push(calls[i]!);
      continue;
    }
    for (const k of chain.indices) taken.add(k);
    const merged = chain.indices
      .slice(1)
      .reduce<unknown>(
        (acc, k) => mergePages(acc, calls[k]!.result, chain.next),
        calls[i]!.result,
      );
    const call = { ...calls[i]!, result: merged };
    out.push(call);
    paginate.set(call, { arg: chain.arg, next: chain.next });
  }
  return { calls: out, paginate };
}

/** The page after `prev`: same tool, same arguments but the page number plus one. */
function isNextPage(
  prev: PageCall,
  cand: PageCall,
  arg: string,
  next: string,
): boolean {
  const page = prev.args[arg];
  if (cand.tool !== prev.tool || typeof page !== "number") return false;
  if (cand.args[arg] !== page + 1) return false;
  if (Object.keys(cand.args).length !== Object.keys(prev.args).length) {
    return false;
  }
  const rest = Object.keys(prev.args).every(
    (k) => k === arg || same(prev.args[k], cand.args[k]),
  );
  return (
    rest &&
    isObject(prev.result) &&
    prev.result[next] === page + 1 &&
    isObject(cand.result)
  );
}

function pageChain(
  calls: PageCall[],
  start: number,
  isReadOnly: (tool: string) => boolean,
  taken: Set<number>,
): { indices: number[]; arg: string; next: string } | null {
  const first = calls[start]!;
  if (!isReadOnly(first.tool) || !isObject(first.result)) return null;
  // the page-number argument and the result field that names the next page
  for (const arg of Object.keys(first.args)) {
    const page = first.args[arg];
    if (typeof page !== "number") continue;
    const next = Object.keys(first.result).find(
      (k) => (first.result as Record<string, unknown>)[k] === page + 1,
    );
    if (next === undefined) continue;

    const indices = [start];
    for (;;) {
      const at = indices[indices.length - 1]!;
      const prev = calls[at]!;
      let found = -1;
      for (let k = at + 1; k < calls.length; k++) {
        if (!isReadOnly(calls[k]!.tool)) break; // a side effect ends the chain
        if (!taken.has(k) && isNextPage(prev, calls[k]!, arg, next)) {
          found = k;
          break;
        }
      }
      if (found < 0) break;
      indices.push(found);
    }
    // the chain must end where the data ended, not where the agent stopped
    const last = calls[indices[indices.length - 1]!]!;
    if (
      indices.length >= 2 &&
      isObject(last.result) &&
      (last.result[next] ?? null) === null
    ) {
      return { indices, arg, next };
    }
  }
  return null;
}
