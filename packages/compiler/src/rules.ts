import type { Condition } from "@hotpathrun/shared";

// Rules that tell runs (or the items of a list) apart, shared by the branch
// learner and the loop detector.

export type Scalar = string | number | boolean | null;
export type Feature = { list: number } | { scalar: Scalar };

/** Lists become their length, plain values stay; nested lists are not entered. */
export function features(
  value: unknown,
  ref: string,
  out: Map<string, Feature>,
  depth = 0,
) {
  if (Array.isArray(value)) {
    out.set(ref, { list: value.length });
  } else if (value !== null && typeof value === "object") {
    if (depth >= 3) return;
    for (const [k, v] of Object.entries(value))
      features(v, `${ref}.${k}`, out, depth + 1);
  } else if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    out.set(ref, { scalar: value });
  }
}

/**
 * A simple rule that is true for every run in `yes` and false for every run in
 * `no`. Empty or not is accepted from one example each (it is what "nothing to
 * do" looks like); a value match needs two examples on each side, or one bit of
 * luck (two different weather summaries) would become a rule.
 */
export function learnRule(
  yes: Array<Map<string, Feature>>,
  no: Array<Map<string, Feature>>,
): Condition | null {
  const refs = [...(yes[0]?.keys() ?? [])].filter((r) =>
    [...yes, ...no].every((f) => f.has(r)),
  );
  for (const ref of refs) {
    const ys = yes.map((f) => f.get(ref)!);
    const ns = no.map((f) => f.get(ref)!);
    if (![...ys, ...ns].every((f) => "list" in f)) continue;
    const len = (f: Feature) => (f as { list: number }).list;
    if (ys.every((f) => len(f) > 0) && ns.every((f) => len(f) === 0)) {
      return { kind: "nonEmpty", ref };
    }
    if (ys.every((f) => len(f) === 0) && ns.every((f) => len(f) > 0)) {
      return { kind: "empty", ref };
    }
  }
  if (yes.length < 2 || no.length < 2) return null;
  for (const ref of refs) {
    const ys = yes.map((f) => f.get(ref)!);
    const ns = no.map((f) => f.get(ref)!);
    if (![...ys, ...ns].every((f) => "scalar" in f)) continue;
    const val = (f: Feature) => (f as { scalar: Scalar }).scalar;
    const y0 = val(ys[0]!);
    if (ys.every((f) => val(f) === y0) && ns.every((f) => val(f) !== y0)) {
      return { kind: "equals", ref, value: y0 };
    }
    const n0 = val(ns[0]!);
    if (ns.every((f) => val(f) === n0) && ys.every((f) => val(f) !== n0)) {
      return { kind: "notEquals", ref, value: n0 };
    }
  }
  return null;
}

/**
 * Thresholds people write are round ("over 10,000", "above 2"); a report also
 * holds totals the agent calculated (12,429.27), which no data holds either.
 * Measured: the accounts-payable rule was first learned as "above 12429.27".
 */
export function byRoundness(numbers: number[]): number[] {
  const zeros = (n: number) => {
    if (!Number.isInteger(n)) return -1;
    let z = 0;
    for (let x = Math.abs(n); x !== 0 && x % 10 === 0; x /= 10) z++;
    return z;
  };
  return [...numbers].sort((a, b) => zeros(b) - zeros(a));
}

/**
 * "Above N" or "below N" on a number field: every run that made the step on one
 * side, every run that did not on the other. N is a number the agent wrote in a
 * recording ("above the 2% threshold") that is not a value in the data, so a field
 * that merely happened to differ (a request count) never becomes a rule. With
 * three runs or more per side and no number written, the middle of the gap.
 */
export function learnNumberRule(
  yes: Array<Map<string, Feature>>,
  no: Array<Map<string, Feature>>,
  written: number[],
  dataValues: Set<number>,
): Condition | null {
  if (yes.length === 0 || no.length === 0) return null;
  const thresholds = byRoundness(
    [...new Set(written)].filter((n) => !dataValues.has(n)),
  );
  const refs = [...yes[0]!.keys()].filter((r) =>
    [...yes, ...no].every((f) => {
      const v = f.get(r);
      return v !== undefined && "scalar" in v && typeof v.scalar === "number";
    }),
  );
  const num = (f: Map<string, Feature>, r: string) =>
    (f.get(r) as { scalar: number }).scalar;
  const many = yes.length >= 3 && no.length >= 3;
  for (const ref of refs) {
    const ys = yes.map((f) => num(f, ref));
    const ns = no.map((f) => num(f, ref));
    const [minY, maxY, minN, maxN] = [
      Math.min(...ys),
      Math.max(...ys),
      Math.min(...ns),
      Math.max(...ns),
    ];
    if (minY > maxN) {
      // yes > N >= every no
      const n = thresholds.find((t) => t >= maxN && t < minY);
      if (n !== undefined) return { kind: "above", ref, value: n };
      if (many)
        return {
          kind: "above",
          ref,
          value: Math.round(((maxN + minY) / 2) * 100) / 100,
        };
    }
    if (maxY < minN) {
      // yes < N <= every no
      const n = thresholds.find((t) => t > maxY && t <= minN);
      if (n !== undefined) return { kind: "below", ref, value: n };
      if (many)
        return {
          kind: "below",
          ref,
          value: Math.round(((maxY + minN) / 2) * 100) / 100,
        };
    }
  }
  return null;
}

type RuleCondition = Extract<
  Condition,
  { kind: "above" | "below" | "before" | "after" }
>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * A rule on items from thresholds the run is grounded in: a number field above or
 * below a number the agent wrote (not a data value), a date field before or after
 * a date input. One part when it separates the items acted on from the rest; two
 * parts ("overdue and over 10,000") only when both are needed. Null otherwise.
 */
export function learnItemThresholdRule(
  yes: Array<Map<string, Feature>>,
  no: Array<Map<string, Feature>>,
  written: number[],
  dataValues: Set<number>,
  inputs: Record<string, unknown>,
): Condition | null {
  if (yes.length === 0 || no.length === 0) return null;
  const all = [...yes, ...no];
  const scalar = (m: Map<string, Feature>, ref: string) => {
    const f = m.get(ref);
    return f && "scalar" in f ? f.scalar : undefined;
  };
  const refs = [...yes[0]!.keys()].filter((r) =>
    all.every((m) => scalar(m, r) !== undefined),
  );
  const thresholds = byRoundness(
    [...new Set(written)].filter(
      (n) => !dataValues.has(n) && Number.isFinite(n),
    ),
  );
  const dates = Object.entries(inputs).filter(
    (e): e is [string, string] =>
      typeof e[1] === "string" && ISO_DATE.test(e[1]),
  );
  const atoms: RuleCondition[] = [];
  for (const ref of refs) {
    if (all.every((m) => typeof scalar(m, ref) === "number")) {
      for (const value of thresholds) {
        atoms.push({ kind: "above", ref, value });
        atoms.push({ kind: "below", ref, value });
      }
    }
  }
  for (const ref of refs) {
    const isDate = (v: unknown) => typeof v === "string" && ISO_DATE.test(v);
    if (all.every((m) => isDate(scalar(m, ref)))) {
      for (const [name] of dates) {
        atoms.push({ kind: "before", ref, other: `inputs.${name}` });
        atoms.push({ kind: "after", ref, other: `inputs.${name}` });
      }
    }
  }
  const holds = (a: RuleCondition, m: Map<string, Feature>): boolean => {
    const v = scalar(m, a.ref);
    if (a.kind === "above") return typeof v === "number" && v > a.value;
    if (a.kind === "below") return typeof v === "number" && v < a.value;
    const other = inputs[a.other.slice("inputs.".length)];
    if (typeof v !== "string" || typeof other !== "string") return false;
    const [x, y] = [v.slice(0, 10), other.slice(0, 10)];
    return a.kind === "before" ? x < y : x > y;
  };
  const separates = (test: (m: Map<string, Feature>) => boolean) =>
    yes.every(test) && no.every((m) => !test(m));
  for (const a of atoms) {
    if (!separates((m) => holds(a, m))) continue;
    // also before/after the run's date when every acted item is and some other
    // item is not: on a day with no big invoice still to come, "over 10,000"
    // alone fits too, and would flag one that is not overdue yet
    if (a.kind === "above" || a.kind === "below") {
      const date = atoms.find(
        (d) =>
          (d.kind === "before" || d.kind === "after") &&
          yes.every((m) => holds(d, m)) &&
          no.some((m) => !holds(d, m)),
      );
      if (date) return { kind: "all", of: [a, date] };
    }
    return a;
  }
  const onYes = atoms.filter((a) => yes.every((m) => holds(a, m)));
  for (let i = 0; i < onYes.length; i++) {
    for (let j = i + 1; j < onYes.length; j++) {
      const [a, b] = [onYes[i]!, onYes[j]!];
      if (a.ref === b.ref) continue;
      if (separates((m) => holds(a, m) && holds(b, m)))
        return { kind: "all", of: [a, b] };
    }
  }
  return null;
}

/**
 * learnRule for the items of one list. A yes/no field (flag, done, urgent) is
 * a rule from one item on each side: it has two values, so a coincidence is
 * unlikely, unlike an id or a title that differs on every item.
 */
export function learnItemRule(
  allYes: Array<Map<string, Feature>>,
  allNo: Array<Map<string, Feature>>,
): Condition | null {
  // "act on T200" names an item, it is no rule: ids came back on several days
  // in the hard-workflow tests and a loop learned to tag T200 every day
  const yes = allYes.map(withoutIdentifiers);
  const no = allNo.map(withoutIdentifiers);
  const rule = learnRule(yes, no);
  if (rule || yes.length === 0 || no.length === 0) return rule;
  const refs = [...yes[0]!.keys()].filter((r) =>
    [...yes, ...no].every((f) => f.has(r)),
  );
  const bool = (f: Feature | undefined, v: boolean) =>
    f !== undefined && "scalar" in f && f.scalar === v;
  for (const ref of refs) {
    for (const v of [true, false]) {
      if (
        yes.every((f) => bool(f.get(ref), v)) &&
        no.every((f) => bool(f.get(ref), !v))
      ) {
        return { kind: "equals", ref, value: v };
      }
    }
  }
  return null;
}

// Fields that name one item (its id, its key): never part of a rule on items.
const IDENTIFIER_FIELD = /(?:^|[._])(?:id|uuid|guid|key|ref)$/i;

function withoutIdentifiers(f: Map<string, Feature>): Map<string, Feature> {
  return new Map([...f].filter(([ref]) => !IDENTIFIER_FIELD.test(ref)));
}

// Field names that hold a small fixed set of values ("urgent", "spam"). For
// these one recording per path is enough to trust "field is X"; for any other
// field one example proves nothing (a subject or an id differs every time).
const CATEGORY_FIELD =
  /\.(priority|category|type|kind|status|severity|level|class|tier|state|urgency|intent|label|action|decision|route|queue)$/i;

/**
 * Like learnRule, for telling apart the paths of a branch: also accepts
 * "field is X" from a single example per path, but only on a category-style
 * field, so a rule is never learned from luck.
 */
export function learnPathRule(
  yes: Array<Map<string, Feature>>,
  no: Array<Map<string, Feature>>,
): Condition | null {
  const rule = learnRule(yes, no);
  if (rule) return rule;
  const refs = [...(yes[0]?.keys() ?? [])].filter(
    (r) => CATEGORY_FIELD.test(r) && [...yes, ...no].every((f) => f.has(r)),
  );
  for (const ref of refs) {
    const ys = yes.map((f) => f.get(ref)!);
    const ns = no.map((f) => f.get(ref)!);
    if (![...ys, ...ns].every((f) => "scalar" in f)) continue;
    const val = (f: Feature) => (f as { scalar: Scalar }).scalar;
    const y0 = val(ys[0]!);
    if (typeof y0 !== "string") continue;
    if (ys.every((f) => val(f) === y0) && ns.every((f) => val(f) !== y0)) {
      return { kind: "equals", ref, value: y0 };
    }
  }
  return null;
}

const filled = (v: unknown): boolean =>
  v !== undefined &&
  v !== null &&
  v !== "" &&
  !(Array.isArray(v) && v.length === 0);

/** Input names that some recordings had (non-empty) and others did not. */
export function varyingInputs(
  inputs: Array<Record<string, unknown>>,
): string[] {
  const names = new Set(inputs.flatMap((i) => Object.keys(i)));
  return [...names].filter((n) => {
    const has = inputs.map((i) => filled(i[n]));
    return has.some(Boolean) && !has.every(Boolean);
  });
}

/** Which of `names` a run's inputs give (non-empty). */
export const givenInputs = (
  inputs: Record<string, unknown>,
  names: string[],
): string[] => names.filter((n) => filled(inputs[n]));

/**
 * A rule on the run's own inputs: an input every `yes` run gave and no `no`
 * run did ("a customer gives an order id or an email"). It needs no data from
 * earlier steps, so it works for the very first step of a workflow.
 */
export function learnInputRule(
  yes: Array<Record<string, unknown>>,
  no: Array<Record<string, unknown>>,
): Condition | null {
  if (yes.length === 0 || no.length === 0) return null;
  for (const name of varyingInputs([...yes, ...no])) {
    const ref = `inputs.${name}`;
    if (yes.every((i) => filled(i[name])) && no.every((i) => !filled(i[name])))
      return { kind: "nonEmpty", ref };
    if (yes.every((i) => !filled(i[name])) && no.every((i) => filled(i[name])))
      return { kind: "empty", ref };
  }
  return null;
}
