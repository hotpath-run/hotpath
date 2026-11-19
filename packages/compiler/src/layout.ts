import { mentions, type Layout, type RowGroup } from "@hotpathrun/shared";

// Finds the lines of a recorded message that are one row per item of a list
// (task 05). The compiler never guesses: a group of lines becomes a row
// template only when
//  - there is one line per item, in the list's order, for every item (2+);
//  - replacing the item's own values gives the same template for every line;
//  - what is left of the line (the label text) holds no digit and no value
//    from the data in another form ("(Paid)" for status "paid", "$412.50" for
//    412.5): a reformatted value would be copied to every row of every later
//    run, and no guard would see it.
// Anything else stays text for the model to write.

interface Source {
  id: string;
  field?: "result" | "results";
  result: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Lists of 2+ objects inside `node`, with their path. Lists inside a list are skipped. */
function lists(
  node: unknown,
  path: string[] = [],
): Array<{ path: string[]; items: Array<Record<string, unknown>> }> {
  if (Array.isArray(node)) {
    return node.length >= 2 && node.every(isObject)
      ? [{ path, items: node as Array<Record<string, unknown>> }]
      : [];
  }
  if (!isObject(node)) return [];
  return Object.entries(node).flatMap(([k, v]) => lists(v, [...path, k]));
}

interface Leaf {
  path: string;
  value: string | number;
}

/** A value's text and number fields by path; with `deep`, lists are entered too. */
function leaves(
  node: unknown,
  deep = false,
  prefix: string[] = [],
  out: Leaf[] = [],
): Leaf[] {
  if (isObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      leaves(v, deep, [...prefix, k], out);
    }
  } else if (Array.isArray(node)) {
    if (deep)
      node.forEach((v, i) => leaves(v, deep, [...prefix, String(i)], out));
  } else if (
    (typeof node === "string" && node.trim().length >= 2) ||
    (typeof node === "number" && Number.isFinite(node))
  ) {
    out.push({ path: prefix.join("."), value: node });
  }
  return out;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The line with the item's own values replaced by `{{item.<field>}}`, longest first. */
function templateOf(line: string, item: Record<string, unknown>): string {
  const fields = leaves(item).sort(
    (a, b) => String(b.value).length - String(a.value).length,
  );
  if (fields.length === 0) return line;
  const pattern = new RegExp(
    fields
      .map((f) =>
        typeof f.value === "number"
          ? // a number only as a whole token: 21 is not part of 2021 or 21.5
            `(?<![\\d.,])${escapeRegExp(String(f.value))}(?![\\d]|[.,]\\d)`
          : escapeRegExp(f.value),
      )
      .join("|"),
    "g",
  );
  return line.replace(pattern, (match) => {
    const hit = fields.find((f) => String(f.value) === match)!;
    return `{{item.${hit.path}}}`;
  });
}

const placeholders = () => /\{\{item(?:\.[^.{}\s]+)*\}\}/g;

/** True when what is left of a row besides its fields is safe to repeat on other data. */
function safeResidue(template: string, data: Leaf[]): boolean {
  const residue = template.replace(placeholders(), " ");
  if (/\d/.test(residue)) return false;
  // a value from the data in the label text: this item's in another form
  // (other case or typography), or another result's (the same on every row
  // that day, wrong on the next)
  return !data.some(
    (f) =>
      (typeof f.value === "number" || f.value.trim().length >= 3) &&
      mentions(residue, f.value),
  );
}

/**
 * The recorded text split into a skeleton and row groups, or undefined when no
 * group of lines qualifies. `fillRows(layout.skeleton, layout.rows, <the
 * recorded data>)` gives back the recorded text exactly.
 */
export function inferLayout(
  example: string,
  sources: Source[],
): Layout | undefined {
  const lines = example.split("\n");
  const taken = new Array<boolean>(lines.length).fill(false);
  const groups: Array<{ start: number; count: number; group: RowGroup }> = [];
  const data = sources.flatMap((s) => leaves(s.result, true));

  for (const source of sources) {
    if ((source.field ?? "result") !== "result") continue;
    for (const list of lists(source.result)) {
      const n = list.items.length;
      for (let start = 0; start + n <= lines.length; start++) {
        if (taken.slice(start, start + n).some(Boolean)) continue;
        const templates = list.items.map((item, i) =>
          templateOf(lines[start + i]!, item),
        );
        const template = templates[0]!;
        if (
          !placeholders().test(template) ||
          templates.some((t) => t !== template) ||
          !safeResidue(template, data)
        ) {
          continue;
        }
        for (let i = start; i < start + n; i++) taken[i] = true;
        groups.push({
          start,
          count: n,
          group: {
            marker: "",
            over: ["steps", source.id, "result", ...list.path].join("."),
            template,
          },
        });
        break;
      }
    }
  }
  if (groups.length === 0) return undefined;

  groups.sort((a, b) => a.start - b.start);
  groups.forEach((g, i) => (g.group.marker = `[[rows:${i + 1}]]`));
  const skeleton: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const g = groups.find((x) => x.start === i);
    if (g) {
      skeleton.push(g.group.marker);
      i += g.count - 1;
    } else {
      skeleton.push(lines[i]!);
    }
  }
  return { skeleton: skeleton.join("\n"), rows: groups.map((g) => g.group) };
}
