// Helpers of `pnpm bench:measure`: statistics, a correctness check that is
// separate from "does the text mention the right words", and a comparison of a
// workflow before and after a recompile.
import type { Workflow } from "@hotpathrun/shared";

/** Nearest-rank percentile (p in 0..100) of a list of numbers; NaN for an empty list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export const mean = (xs: number[]) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * What a correct report must satisfy beyond mentioning words. `total` is the
 * figure on the line that says "total"; `lines` are the items the report must
 * account for, each with the amount that must appear next to its reference;
 * `matched` are items that must NOT be reported as missing.
 */
export interface Exact {
  total?: { value: number; tolerance?: number };
  lines?: Array<{ ref: string; amount: number }>;
  matched?: string[];
}

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/g;
const numbersIn = (text: string): number[] =>
  (text.match(NUMBER) ?? []).map((n) => Number(n.replace(/,/g, "")));

/** Problems with a report's content; an empty list means it is correct. */
export function correctnessProblems(text: string, exact: Exact): string[] {
  const problems: string[] = [];
  const lines = text.split("\n");
  if (exact.total) {
    const tol = exact.total.tolerance ?? 0.01;
    const want = Math.abs(exact.total.value);
    const totalNumbers = lines
      .filter((l) => /\btotal\b/i.test(l))
      .flatMap(numbersIn)
      .map(Math.abs);
    if (totalNumbers.length === 0) {
      problems.push(`no total in the report (expected ${exact.total.value})`);
    } else if (!totalNumbers.some((n) => Math.abs(n - want) <= tol)) {
      problems.push(
        `total is ${totalNumbers.join(" / ")}, expected ${exact.total.value}`,
      );
    }
  }
  for (const item of exact.lines ?? []) {
    const mine = lines.filter((l) => l.includes(item.ref));
    if (mine.length === 0) {
      problems.push(`${item.ref} is not in the report`);
      continue;
    }
    const ok = mine
      .flatMap(numbersIn)
      .some((n) => Math.abs(Math.abs(n) - Math.abs(item.amount)) <= 0.01);
    if (!ok) problems.push(`${item.ref}: amount ${item.amount} is not shown`);
  }
  for (const ref of exact.matched ?? []) {
    // A matched item reported as missing: it sits in a list that is labelled
    // missing ("Unmatched: …, BK-2004"), or the report says it is not there
    // ("BK-2004 is not in the ledger"). "Total unmatched … (excludes BK-2004)"
    // "please review BK-2004" and "BK-1006 pending a rate" say neither.
    const label =
      /(unmatched|not in (?:the )?ledger|missing(?: from (?:the )?ledger)?|no ledger entry)[^:\n]{0,40}:/i;
    const verbal = new RegExp(
      `${ref}[^.;\\n]{0,25}\\b(?:is|are) (?:not in the ledger|missing|unmatched|not matched)`,
      "i",
    );
    const wrong = text.split("\n").some((line) => {
      if (
        !line.includes(ref) ||
        /\btotal\b|exclud|except|leaving out|pending/i.test(line)
      ) {
        return false;
      }
      const m = label.exec(line);
      const afterLabel = m ? line.slice(m.index + m[0].length) : "";
      return afterLabel.includes(ref) || verbal.test(line);
    });
    if (wrong)
      problems.push(`${ref} is matched but the report calls it missing`);
  }
  return problems;
}

export interface Preservation {
  /** same action tools, in the same order, with the same fixed arguments */
  sideEffects: boolean;
  /** every tool step still has a result schema; every AI step keeps its checks */
  guards: boolean;
  stepsBefore: number;
  stepsAfter: number;
  problems: string[];
}

const actions = (w: Workflow) => {
  const out: Array<{ tool: string; fixed: string }> = [];
  const visit = (steps: Workflow["steps"]): void => {
    for (const s of steps) {
      if (s.type === "tool" && s.sideEffect) {
        const fixed = Object.entries(s.args)
          .filter(([, v]) => !(typeof v === "string" && v.includes("{{")))
          .sort(([a], [b]) => a.localeCompare(b));
        out.push({ tool: s.tool, fixed: JSON.stringify(fixed) });
      } else if (s.type === "foreach") visit(s.body);
      else if (s.type === "branch") {
        for (const c of s.cases) visit(c.steps);
      }
    }
  };
  visit(w.steps);
  return out;
};

const guardIssues = (w: Workflow): string[] => {
  const out: string[] = [];
  const visit = (steps: Workflow["steps"]): void => {
    for (const s of steps) {
      if (s.type === "tool" && !s.sideEffect && !s.guard.schema) {
        out.push(`${s.id} (${s.tool}) has no result schema`);
      } else if (s.type === "llm") {
        if (!s.guard.nonEmpty) out.push(`${s.id} lost its non-empty check`);
        if (s.guard.maxChars === undefined) {
          out.push(`${s.id} lost its length limit`);
        }
      } else if (s.type === "foreach") visit(s.body);
      else if (s.type === "branch") for (const c of s.cases) visit(c.steps);
    }
  };
  visit(w.steps);
  return out;
};

const groundingCount = (w: Workflow): number =>
  w.steps.reduce(
    (n, s) => n + (s.type === "llm" ? (s.guard.grounding ?? []).length : 0),
    0,
  );

/** What a recompiled workflow kept of the one it replaced. */
export function workflowPreservation(
  before: Workflow,
  after: Workflow,
): Preservation {
  const problems: string[] = [];
  const a = actions(before);
  const b = actions(after);
  const sideEffects = JSON.stringify(a) === JSON.stringify(b);
  if (!sideEffects) {
    problems.push(
      `side effects changed: ${a.map((x) => x.tool).join(",") || "none"} -> ${b.map((x) => x.tool).join(",") || "none"}`,
    );
  }
  const issues = guardIssues(after);
  if (issues.length > 0) problems.push(...issues);
  if (groundingCount(before) > 0 && groundingCount(after) === 0) {
    problems.push("the AI step lost all its grounding checks");
  }
  return {
    sideEffects,
    guards: issues.length === 0,
    stepsBefore: before.steps.length,
    stepsAfter: after.steps.length,
    problems,
  };
}
