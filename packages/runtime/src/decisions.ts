// Per-item decisions (compiler rule 12): one question to the replay model for all
// items of a list, answered as JSON and checked by code before any action runs.
import {
  detailsPerItem,
  renderTemplate,
  type ItemDecision,
  type TemplateContext,
} from "@hotpathrun/shared";

export type Decision = Record<string, unknown> & { action: string };

export type ParsedDecisions =
  { ok: true; decisions: Decision[] } | { ok: false; error: string };

function keyOf(item: unknown, path: string[]): unknown {
  let value = item;
  for (const p of path) {
    value =
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)[p]
        : undefined;
  }
  return value;
}

const keyText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function choiceText(decide: ItemDecision): string {
  return [
    ...decide.actions.map((a) => {
      const fields = Object.entries(a.fields).map(([k, t]) => `${k}: ${t}`);
      return fields.length > 0 ? `${a.tool} (${fields.join(", ")})` : a.tool;
    }),
    "none",
  ].join(" | ");
}

/**
 * The question: the run's data, the items to decide on, the recorded decisions, the
 * answer format. `order` lists the items in another order (indices into `items`):
 * the second opinion is asked that way, so an answer by position shows up.
 */
export function decisionPrompt(
  decide: ItemDecision,
  items: unknown[],
  as: string,
  ctx: TemplateContext,
  order: number[] = items.map((_, i) => i),
): string {
  const data = String(renderTemplate(decide.prompt, ctx));
  const keyName = decide.key.join(".");
  const details = decide.details
    ? detailsPerItem(
        items,
        ctx.steps[decide.details.step]?.results,
        decide.details.distinct,
      )
    : items.map(() => undefined);
  // details pair with items by position, so they are looked up before reordering
  const list = order
    .map(
      (at, i) =>
        `${i + 1}. ${keyText(keyOf(items[at], decide.key))}: ${JSON.stringify(items[at])}` +
        (details[at] !== undefined
          ? ` details ${JSON.stringify(details[at])}`
          : ""),
    )
    .join("\n");
  const examples = decide.examples.map((e) => JSON.stringify(e)).join("\n");
  const sample = JSON.stringify({
    [keyName]: keyText(keyOf(items[order[0] ?? 0], decide.key)),
    action: decide.actions[0]!.tool,
    ...Object.fromEntries(
      Object.entries(decide.actions[0]!.fields).map(([k, t]) => [
        k,
        t === "number" ? 0 : "…",
      ]),
    ),
  });
  return [
    data,
    `Decide what to do with each ${as} (by ${keyName}), in this order:\n${list}`,
    `How the recorded run decided, on another day's data (each ${as}, its details when it had some, and what was done):\n${examples}`,
    `Possible actions: ${choiceText(decide)}`,
    "Decide each one from its own data in this run, following the same rule as the recorded decisions. " +
      "Give the values each action needs from this run's data, never from the examples. " +
      `Reply with only a JSON list, one object per ${as} in the order above, like ${sample}. No other text.`,
  ].join("\n\n");
}

/** The model's answer, checked: one decision per item in order, a known action, the fields it needs. */
export function parseDecisions(
  text: string,
  items: unknown[],
  decide: ItemDecision,
): ParsedDecisions {
  const raw = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: `the answer is not a JSON list: ${JSON.stringify(text.slice(0, 80))}`,
    };
  }
  if (parsed.length !== items.length) {
    return {
      ok: false,
      error: `one decision per item: ${items.length} items, ${parsed.length} decision${parsed.length === 1 ? "" : "s"}`,
    };
  }
  const keyName = decide.key.join(".");
  const allowed = [...decide.actions.map((a) => a.tool), "none"];
  const decisions: Decision[] = [];
  for (const [i, entry] of parsed.entries()) {
    const want = keyText(keyOf(items[i], decide.key));
    if (entry === null || typeof entry !== "object") {
      return { ok: false, error: `decision ${i + 1} is not an object` };
    }
    const d = entry as Record<string, unknown>;
    const got = d[keyName] ?? keyOf(d, decide.key);
    if (got !== undefined && keyText(got) !== want) {
      return {
        ok: false,
        error: `decision ${i + 1} is for ${keyText(got)}, item ${i + 1} is ${want}`,
      };
    }
    if (typeof d.action !== "string" || !allowed.includes(d.action)) {
      return {
        ok: false,
        error: `${want}: ${JSON.stringify(d.action)} is not one of ${allowed.join(", ")}`,
      };
    }
    const action = decide.actions.find((a) => a.tool === d.action);
    for (const [field, type] of Object.entries(action?.fields ?? {})) {
      const v = d[field];
      const ok =
        type === "number"
          ? typeof v === "number" && Number.isFinite(v)
          : typeof v === "string" && v.trim() !== "";
      if (!ok)
        return {
          ok: false,
          error: `${want}: ${d.action} needs ${field} (${type})`,
        };
    }
    decisions.push(d as Decision);
  }
  return { ok: true, decisions };
}

const sameText = (a: unknown, b: unknown) =>
  String(a).trim().replace(/\s+/g, " ").toLowerCase() ===
  String(b).trim().replace(/\s+/g, " ").toLowerCase();

const sameNumber = (a: unknown, b: unknown) =>
  typeof a === "number" &&
  typeof b === "number" &&
  Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

function decisionText(d: Decision, decide: ItemDecision): string {
  const fields = Object.keys(
    decide.actions.find((a) => a.tool === d.action)?.fields ?? {},
  );
  return fields.length > 0
    ? `${d.action} ${JSON.stringify(Object.fromEntries(fields.map((k) => [k, d[k]])))}`
    : d.action;
}

/**
 * Two answers for the same items (both in item order), compared on what replay acts
 * on: the action and the values that action needs. One line per item that differs.
 */
export function compareDecisions(
  a: Decision[],
  b: Decision[],
  items: unknown[],
  decide: ItemDecision,
): string[] {
  const out: string[] = [];
  for (const [i, item] of items.entries()) {
    const x = a[i]!;
    const y = b[i]!;
    const fields =
      decide.actions.find((t) => t.tool === x.action)?.fields ?? {};
    const same =
      x.action === y.action &&
      Object.entries(fields).every(([k, type]) =>
        type === "number" ? sameNumber(x[k], y[k]) : sameText(x[k], y[k]),
      );
    if (!same)
      out.push(
        `${keyText(keyOf(item, decide.key))}: ${decisionText(x, decide)} vs ${decisionText(y, decide)}`,
      );
  }
  return out;
}
