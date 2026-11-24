// Lists an llm step does not need to see: code computes every figure the recorded
// text took from them (see the compiler's trim.ts). Measured: on the hard bench's big
// logs day the replay sent 1,200 log lines to the model and cost about what the agent
// cost, although code had already counted the errors.
import type { TemplateContext } from "./template.js";

export const trimmedNote = (n: number): string =>
  `(${n} items not shown: code computed the figures below from all of them)`;

/**
 * The context with each list at these paths (`steps.s1.result.lines`, or
 * `steps.s2.results.*.orders` for every result's list) replaced by a note, or
 * null when a path is not a list today (then nothing is left out).
 */
export function trimData(
  ctx: TemplateContext,
  paths: string[],
): TemplateContext | null {
  const steps = structuredClone(ctx.steps) as Record<string, unknown>;
  for (const p of paths) {
    const parts = p.split(".");
    if (parts[0] !== "steps" || !replaceAt(steps, parts.slice(1))) return null;
  }
  return { ...ctx, steps: steps as TemplateContext["steps"] };
}

function replaceAt(node: unknown, parts: string[]): boolean {
  const [key, ...rest] = parts;
  if (key === undefined) return false;
  if (key === "*") {
    return Array.isArray(node) && node.every((n) => replaceAt(n, rest));
  }
  if (node === null || typeof node !== "object") return false;
  const obj = node as Record<string, unknown>;
  if (rest.length === 0) {
    const list = obj[key];
    if (!Array.isArray(list)) return false;
    obj[key] = trimmedNote(list.length);
    return true;
  }
  return replaceAt(obj[key], rest);
}
