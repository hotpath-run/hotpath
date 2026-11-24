// Per-item choices that follow a small rulebook: a ticket's category picks the
// action, its priority or an amount threshold the rest ("billing with amount 50 or
// less -> issue_refund(amount), over 50 -> forward_to_finance"). Measured on the hard
// bench: a free replay model, shown the recorded examples, forwarded a 50 refund the
// same way twice, so decide twice could not catch it. A table learned from the
// recorded choices decides by code; an item it has never seen the like of goes to the
// model as before, and one between recorded amounts to the agent.
import { z } from "zod";

import { inBand, type Band } from "./bands.js";

const valueSchema = z.union([
  z.object({ const: z.union([z.string(), z.number()]) }),
  z.object({
    from: z.enum(["item", "details"]),
    path: z.array(z.string()).min(1),
  }),
]);

export type TableNode =
  | {
      leaf: {
        action: string;
        values: Record<string, z.infer<typeof valueSchema>>;
      };
    }
  | {
      from: "item" | "details";
      path: string[];
      cases: Record<string, TableNode>;
    }
  | {
      from: "item" | "details";
      path: string[];
      bands: Array<Omit<Band, "value"> & { node: TableNode }>;
    };

const bandSchema = z.object({
  gte: z.number().optional(),
  lte: z.number().optional(),
  lt: z.number().optional(),
});

export const tableNodeSchema: z.ZodType<TableNode, z.ZodTypeDef, unknown> =
  z.lazy(() =>
    z.union([
      z.object({
        leaf: z.object({
          action: z.string(),
          values: z.record(z.string(), valueSchema),
        }),
      }),
      z.object({
        from: z.enum(["item", "details"]),
        path: z.array(z.string()).min(1),
        cases: z.record(z.string(), tableNodeSchema),
      }),
      z.object({
        from: z.enum(["item", "details"]),
        path: z.array(z.string()).min(1),
        bands: z.array(bandSchema.extend({ node: tableNodeSchema })).min(2),
      }),
    ]),
  );

function at(node: unknown, path: string[]): unknown {
  let v = node;
  for (const k of path)
    v =
      v !== null && typeof v === "object"
        ? (v as Record<string, unknown>)[k]
        : undefined;
  return v;
}

export type TableAnswer =
  | { decision: { action: string; [field: string]: unknown } }
  /** a number between two recorded bands: no evidence for either side */
  | { gap: string }
  /** a value the recording never had (a new category): the model decides */
  | { unknown: string };

/** The table's decision for one item. */
export function tableDecision(
  node: TableNode,
  item: unknown,
  details: unknown,
): TableAnswer {
  if ("leaf" in node) {
    const out: { action: string; [field: string]: unknown } = {
      action: node.leaf.action,
    };
    for (const [field, v] of Object.entries(node.leaf.values)) {
      const got =
        "const" in v ? v.const : at(v.from === "item" ? item : details, v.path);
      if (got === undefined || got === null)
        return { unknown: `no ${"path" in v ? v.path.join(".") : field}` };
      out[field] = got;
    }
    return { decision: out };
  }
  const value = at(node.from === "item" ? item : details, node.path);
  const name = node.path.join(".");
  if ("cases" in node) {
    const next =
      typeof value === "string" || typeof value === "number"
        ? node.cases[String(value)]
        : undefined;
    return next
      ? tableDecision(next, item, details)
      : { unknown: `${name} ${JSON.stringify(value)}` };
  }
  if (typeof value !== "number" || !Number.isFinite(value))
    return { unknown: `${name} ${JSON.stringify(value)}` };
  const band = node.bands.find((b) => inBand(b, value));
  if (band) return tableDecision(band.node, item, details);
  const below = node.bands.some(
    (b) =>
      (b.lte !== undefined && b.lte < value) ||
      (b.lt !== undefined && b.lt <= value),
  );
  const above = node.bands.some((b) => b.gte !== undefined && b.gte > value);
  return below && above
    ? { gap: `${name} ${value}` }
    : { unknown: `${name} ${value}` };
}

/** How many leaves (rules) the table has: for the run output. */
export function tableSize(node: TableNode): number {
  if ("leaf" in node) return 1;
  if ("cases" in node)
    return Object.values(node.cases).reduce((n, c) => n + tableSize(c), 0);
  return node.bands.reduce((n, b) => n + tableSize(b.node), 0);
}
