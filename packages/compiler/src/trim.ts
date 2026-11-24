// Which lists an llm step can be sent without (A.8, the replay cost guard). A list
// is left out only when the recording proves it safe: the recorded text, written
// from the prompt with those lists replaced by a note plus the figures code computes,
// would have had every number and every word it took from them. Anything else the
// agent wrote from the items (an id, a name, a figure code does not compute) keeps
// the list in the prompt.
import {
  computeFigures,
  listAt,
  numbersInText,
  renderTemplate,
  round2,
  trimData,
  type Calculation,
  type GroundingEntry,
  type TemplateContext,
} from "@hotpathrun/shared";

/** fewer items than this cost little to send: not worth any risk */
const MIN_ITEMS = 20;

/** The lists a calculation reads its items from, as paths (`*` for every result). */
export function listsRead(calc: Calculation): string[] {
  if (calc.selection) return [];
  if (calc.group) {
    return calc.group.refs
      ? calc.group.refs.map((r) => `${r}.${calc.group!.path}`)
      : [`${calc.list}.*.${calc.group.path}`];
  }
  return [calc.list];
}

const pathPattern = (p: string) =>
  new RegExp(
    "^" +
      p
        .split(".")
        .map((k) =>
          k === "*" ? "(\\d+|\\*)" : k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("\\.") +
      "(\\.|$)",
  );

const tokens = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*[a-z0-9]/g) ?? []).filter(
      (t) => /[a-z]/.test(t),
    ),
  );

export interface TrimOptions {
  prompt: string;
  example: string;
  ctx: TemplateContext;
  calcs: Calculation[];
  grounding?: GroundingEntry[];
}

/** The list paths to leave out of the step's prompt; empty when none is safe to. */
export function learnTrim(o: TrimOptions): string[] {
  if (process.env.HOTPATH_TRIM === "0") return [];
  const grounded = (o.grounding ?? []).flatMap((g) => g.paths);
  const paths = [...new Set(o.calcs.flatMap(listsRead))].filter((p) => {
    const items = listAt(p, o.ctx);
    if (!items || items.length < MIN_ITEMS) return false;
    // the model must name values inside it (grounding): it has to see them
    const inside = pathPattern(p);
    return !grounded.some((g) => inside.test(g));
  });
  if (paths.length === 0) return [];
  const trimmed = trimData(o.ctx, paths);
  if (!trimmed) return [];
  // every figure over a left-out list must be computable, or the model has nothing
  const figures: Array<{ text: string; value: number }> = [];
  for (const c of o.calcs) {
    const got = computeFigures(c, o.ctx);
    if (got === null) {
      if (listsRead(c).some((l) => paths.includes(l))) return [];
      continue;
    }
    figures.push(...got);
  }
  const sent = renderTemplate(o.prompt, trimmed) as string;
  const known = [
    sent,
    ...figures.map((f) => f.text),
    ...o.calcs.flatMap((c) => [
      c.match ?? "",
      c.where?.equals ?? "",
      c.where?.not ?? "",
    ]),
  ].join("\n");
  const removed = paths
    .map((p) => JSON.stringify(listAt(p, o.ctx) ?? []))
    .join("\n");
  // every number of the recorded text: a figure code computes, or in what is still sent
  const knownNumbers = new Set([
    ...numbersInText(known).map(round2),
    ...figures.map((f) => round2(f.value)),
  ]);
  if (numbersInText(o.example).some((n) => !knownNumbers.has(round2(n))))
    return [];
  // every word the recorded text shares with the left-out items is still sent
  const knownWords = tokens(known);
  const removedWords = tokens(removed);
  for (const w of tokens(o.example)) {
    if (removedWords.has(w) && !knownWords.has(w)) return [];
  }
  return paths;
}
