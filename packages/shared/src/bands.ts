// Per-item choices that follow one number in bands: a lead's tier from its company's
// employee count. Measured on the hard bench: a free replay model, asked twice, gave
// a different tier for 1 to 3 leads out of 7-24 on every day, so every crm replay
// went to the agent. Code applies the recorded bands; an item whose number falls
// between bands the recording never closed goes to the agent, whose recording closes it.
import type { ItemDecision } from "./schemas.js";

export type DecisionBands = NonNullable<ItemDecision["bands"]>;
export type Band = DecisionBands["bands"][number];

export function inBand(
  band: Pick<Band, "gte" | "lte" | "lt">,
  v: number,
): boolean {
  return (
    (band.gte === undefined || v >= band.gte) &&
    (band.lte === undefined || v <= band.lte) &&
    (band.lt === undefined || v < band.lt)
  );
}

function numberAt(node: unknown, path: string[]): number | null {
  let v = node;
  for (const k of path)
    v =
      v !== null && typeof v === "object"
        ? (v as Record<string, unknown>)[k]
        : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The decision for one item by the bands, or null when its number is in none. */
export function bandDecision(
  rule: DecisionBands,
  item: unknown,
  details: unknown,
): { action: string; [field: string]: unknown } | null {
  const v = numberAt(rule.from === "item" ? item : details, rule.path);
  if (v === null) return null;
  const band = rule.bands.find((b) => inBand(b, v));
  return band ? { action: rule.action, [rule.field]: band.value } : null;
}

/** "employees: below 100 smb, 100 to 999 mid, 1000 or more enterprise" */
export function bandsText(rule: DecisionBands): string {
  const one = (b: Band) => {
    const lo = b.gte !== undefined ? `${b.gte}` : undefined;
    const hi =
      b.lt !== undefined
        ? `below ${b.lt}`
        : b.lte !== undefined
          ? `up to ${b.lte}`
          : undefined;
    const range = lo && hi ? `${lo}, ${hi}` : lo ? `${lo} or more` : hi;
    return `${range}: ${b.value}`;
  };
  return `${rule.path.join(".")}: ${rule.bands.map(one).join("; ")}`;
}

/**
 * The item's number when it falls between two bands the recording never
 * closed (999 mid, 1500 enterprise, today 1000): no evidence says which side
 * it is on, and a model guesses (on the hard bench, the same wrong way twice).
 */
export function inOpenGap(
  rule: DecisionBands,
  item: unknown,
  details: unknown,
): number | null {
  const v = numberAt(rule.from === "item" ? item : details, rule.path);
  if (v === null || rule.bands.some((b) => inBand(b, v))) return null;
  const below = rule.bands.some(
    (b) =>
      (b.lte !== undefined && b.lte < v) || (b.lt !== undefined && b.lt <= v),
  );
  const above = rule.bands.some((b) => b.gte !== undefined && b.gte > v);
  return below && above ? v : null;
}
