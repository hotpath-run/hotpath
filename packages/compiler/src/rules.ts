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
