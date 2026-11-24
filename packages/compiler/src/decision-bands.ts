// Learns bands for per-item choices (see shared/bands.ts): every recorded item got
// one action with one text value, and that value follows one number of the item or
// its details without overlap (smb below enterprise, never mixed). A gap between two
// bands is closed by a number the agent wrote there ("mid 100–999, enterprise
// ≥1000"); a gap nobody wrote about stays open and items in it go to the model.
import {
  numbersInText,
  type DecisionBands,
  type GroundingEntry,
  type ItemDecision,
  type Workflow,
} from "@hotpathrun/shared";

import { learnTable } from "./decision-table.js";
import { byRoundness } from "./rules.js";

type Item = Record<string, unknown>;
const isItem = (v: unknown): v is Item =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const numericKeys = (nodes: unknown[]): string[] => {
  if (nodes.length === 0 || !nodes.every(isItem)) return [];
  return Object.keys(nodes[0] as Item).filter((k) =>
    (nodes as Item[]).every(
      (n) => typeof n[k] === "number" && Number.isFinite(n[k]),
    ),
  );
};

export function learnBands(
  decide: ItemDecision,
  written: number[],
): DecisionBands | null {
  const ex = decide.examples;
  if (ex.length < 4) return null;
  const action = ex[0]!.choice.action;
  if (typeof action !== "string" || action === "none") return null;
  if (!ex.every((e) => e.choice.action === action)) return null;
  const fields = Object.keys(ex[0]!.choice).filter((k) => k !== "action");
  if (fields.length !== 1) return null;
  const field = fields[0]!;
  const values = ex.map((e) => e.choice[field]);
  if (!values.every((v) => typeof v === "string")) return null;
  if (Object.keys(ex[0]!.choice).length !== 2) return null;
  const distinct = [...new Set(values as string[])];
  if (distinct.length < 2) return null;

  const sources: Array<{ from: "item" | "details"; key: string }> = [
    ...numericKeys(ex.map((e) => e.details)).map((key) => ({
      from: "details" as const,
      key,
    })),
    ...numericKeys(ex.map((e) => e.item)).map((key) => ({
      from: "item" as const,
      key,
    })),
  ];
  const found: Array<{ rule: DecisionBands; closed: number }> = [];
  for (const { from, key } of sources) {
    const num = (e: (typeof ex)[number]) =>
      (e[from === "item" ? "item" : "details"] as Item)[key] as number;
    const ranges = distinct
      .map((value) => {
        const ns = ex.filter((e) => e.choice[field] === value).map(num);
        return {
          value,
          min: Math.min(...ns),
          max: Math.max(...ns),
          n: ns.length,
        };
      })
      .sort((a, b) => a.min - b.min);
    // a value on both sides of another is no band
    if (ranges.some((r, i) => i > 0 && ranges[i - 1]!.max >= r.min)) continue;
    let closed = 0;
    const cuts = ranges.slice(1).map((hi, i) => {
      const lo = ranges[i]!;
      // whole numbers side by side (99 smb, 100 mid): no item can fall between
      const adjacent =
        Number.isInteger(lo.max) &&
        Number.isInteger(hi.min) &&
        hi.min - lo.max === 1;
      const cut = adjacent
        ? hi.min
        : byRoundness(written.filter((w) => w > lo.max && w <= hi.min))[0];
      if (cut !== undefined) closed++;
      return { lo: lo.max, hi: hi.min, cut };
    });
    // one item per value fitting a line by chance is no rule: a written
    // threshold, or three items of every value
    if (closed === 0 && ranges.some((r) => r.n < 3)) continue;
    const bands = ranges.map((r, i) => {
      const below = cuts[i - 1];
      const above = cuts[i];
      return {
        value: r.value,
        ...(below ? { gte: below.cut ?? below.hi } : {}),
        ...(above
          ? above.cut !== undefined
            ? { lt: above.cut }
            : { lte: above.lo }
          : {}),
      };
    });
    found.push({ rule: { from, path: [key], action, field, bands }, closed });
  }
  if (found.length === 0) return null;
  const best = Math.max(...found.map((f) => f.closed));
  const top = found.filter((f) => f.closed === best);
  // two numbers that both explain the choices: not sure which one it is
  return top.length === 1 ? top[0]!.rule : null;
}

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
// "≥1000", "< 100", "100–999", "1000 or more", "below 100", "at least 1,000"
const THRESHOLD = new RegExp(
  String.raw`(?:[≥≤<>]=?\s*|\b(?:below|under|over|above|at least|at most|fewer than|less than|more than)\s+)(${NUM})` +
    String.raw`|(${NUM})\s*(?:[–—-]|to)\s*(${NUM})` +
    String.raw`|(${NUM})\s*(?:\+|or more|or fewer|or less|and above|and up|and below)`,
  "gi",
);

/** Numbers the text writes as a threshold, not every number in it (a count is none). */
export function writtenThresholds(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(THRESHOLD)) {
    for (const g of m.slice(1)) {
      if (g === undefined) continue;
      const [n] = numbersInText(g);
      if (n !== undefined) out.push(n);
    }
  }
  return out;
}

/** Sets `decide.bands` on every loop whose recorded choices follow bands. */
export function markDecisionBands(workflow: Workflow): Workflow {
  if (process.env.HOTPATH_BANDS === "0") return workflow;
  const written = workflow.steps.flatMap((s) =>
    s.type === "llm" ? writtenThresholds(s.example) : [],
  );
  const limits = new Set<number>();
  const bandKeys: string[] = [];
  const steps = workflow.steps.map((s) => {
    if (s.type !== "foreach" || !s.decide) return s;
    const bands = learnBands(s.decide, written);
    if (!bands) {
      // a rulebook of several fields (category, then priority or an amount)
      const table = learnTable(s.decide, written);
      return table ? { ...s, decide: { ...s.decide, table } } : s;
    }
    bandKeys.push(bands.path.join("."));
    for (const b of bands.bands)
      for (const n of [b.gte, b.lte, b.lt]) if (n !== undefined) limits.add(n);
    return { ...s, decide: { ...s.decide, bands } };
  });
  if (limits.size === 0) return { ...workflow, steps };
  // "mid 100–999" defines the bands: written again on every run, it is no
  // fact copied from the recorded data (a company had 999 employees)
  const isWrittenLimit = (fact: string | number) => {
    const n =
      typeof fact === "number"
        ? fact
        : /^\s*\d[\d,]*(?:\.\d+)?\s*$/.test(fact)
          ? Number(fact.replace(/,/g, ""))
          : NaN;
    return limits.has(n) || written.includes(n);
  };
  // …nor does it cite the item that happened to have that number
  const keys = new Set(bandKeys);
  const citesByLimit = (g: GroundingEntry) =>
    g.positions !== undefined &&
    isWrittenLimit(g.value) &&
    g.paths.every((p) => [...keys].some((k) => p.endsWith(`.*.${k}`)));
  return {
    ...workflow,
    steps: steps.map((s) =>
      s.type === "llm"
        ? {
            ...s,
            guard: {
              ...s.guard,
              ...(s.guard.exampleFacts
                ? {
                    exampleFacts: s.guard.exampleFacts.filter(
                      (f) => !isWrittenLimit(f),
                    ),
                  }
                : {}),
              ...(s.guard.grounding
                ? {
                    grounding: s.guard.grounding.filter(
                      (g) => !citesByLimit(g),
                    ),
                  }
                : {}),
            },
          }
        : s,
    ),
  };
}
