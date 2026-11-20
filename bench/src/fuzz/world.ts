// The fuzzer's world: generated data, tools over it, a scripted agent that
// records traces, and a fake model that can only mention what its prompt shows.
// Everything is in memory and seeded, so any failure replays from its seed.

import type { TraceFile, TraceToolInfo } from "@hotpathrun/shared";

/** mulberry32: small, fast, good enough to pick test cases. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rand = ReturnType<typeof rng>;
export const pick = <T>(r: Rand, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)]!;
export const int = (r: Rand, lo: number, hi: number) =>
  lo + Math.floor(r() * (hi - lo + 1));

const WORDS = [
  "alpha",
  "bravo",
  "cedar",
  "delta",
  "ember",
  "fjord",
  "garnet",
  "harbor",
  "indigo",
  "juniper",
  "kestrel",
  "lumen",
  "marble",
  "nectar",
  "orbit",
  "pepper",
  "quartz",
  "raven",
  "saffron",
  "tundra",
  "umber",
  "velvet",
  "willow",
  "xenon",
  "yonder",
  "zephyr",
];
const OWNERS = ["Ana", "Ben", "Chloe", "Dev", "Eli", "Fatou", "Goran", "Hana"];
const WEATHER = ["sunny", "light rain", "overcast", "windy", "snow showers"];

export interface Item {
  id: string;
  title: string;
  owner: string;
  amount: number;
  flag: boolean;
  body: string;
}

/** How the replay's data differs from the recordings'. */
export const MUTATIONS = [
  "fresh", // same shape, new values
  "longer", // more items than any recording had
  "shorter", // one item
  "empty", // no items
  "extra-fields", // every result gains fields nobody asked for
  "renamed", // list items call `title` `name`
  "missing-field", // get_item results lose `body`
  "tool-error", // one read fails
  "type-change", // amounts come back as strings
  "null-field", // a field nobody uses comes back null (a parcel not delivered yet)
] as const;
export type Mutation = (typeof MUTATIONS)[number];

export interface Dataset {
  date: string;
  items: Item[];
  weather: string;
  visits: number;
  signups: number;
  mutation: Mutation;
  /** id of the item whose get_item fails (tool-error) */
  failing?: string;
  /** lookup tasks: what the customer gave, an item id or an email */
  lookup?: { id: string } | { email: string };
}

/** The run's inputs: the date, plus whatever a lookup customer gave. */
export function inputsOf(ds: Dataset): Record<string, string> {
  return { date: ds.date, ...(ds.lookup ?? {}) };
}

const emailOf = (item: Item) =>
  `${item.owner.toLowerCase()}.${item.id}@example.com`;

let counter = 0;
export function makeItems(r: Rand, n: number): Item[] {
  return Array.from({ length: n }, () => {
    counter++;
    const id = `it-${counter.toString(36)}${Math.floor(r() * 1e6).toString(36)}`;
    return {
      id,
      title: `${pick(r, WORDS)} ${pick(r, WORDS)} report`,
      owner: pick(r, OWNERS),
      amount: int(r, 1, 900),
      flag: r() < 0.4,
      body: `${pick(r, WORDS)} ${pick(r, WORDS)} needs review ${int(r, 10, 99)}`,
    };
  });
}

export function makeDataset(
  r: Rand,
  date: string,
  n: number,
  mutation: Mutation = "fresh",
): Dataset {
  const items = makeItems(r, n);
  return {
    date,
    items,
    weather: pick(r, WEATHER),
    visits: int(r, 100, 9000),
    signups: int(r, 1, 300),
    mutation,
    failing:
      mutation === "tool-error" && items.length > 0
        ? pick(r, items).id
        : undefined,
  };
}

export const TOOLS: TraceToolInfo[] = [
  {
    name: "find_by_email",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_items",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_item",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_weather",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_stats",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "send_message",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: false },
  },
  {
    name: "archive_item",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: false },
  },
];
export const SIDE_EFFECTS = new Set(["send_message", "archive_item"]);

export interface ToolAnswer {
  value: unknown;
  isError: boolean;
}

/** The tools, answering from one dataset with its mutation applied. */
export function answer(
  ds: Dataset,
  tool: string,
  args: Record<string, unknown>,
): ToolAnswer {
  const extra =
    ds.mutation === "extra-fields" ? { meta: { v: 2, source: "fuzz" } } : {};
  const amount = (a: number) => (ds.mutation === "type-change" ? String(a) : a);
  switch (tool) {
    case "list_items":
      if (args.date !== ds.date) {
        return { value: `no data for ${String(args.date)}`, isError: true };
      }
      return {
        value: {
          items: ds.items.map((i) => {
            const base: Record<string, unknown> = {
              id: i.id,
              owner: i.owner,
              amount: amount(i.amount),
              flag: i.flag,
              // no task reads it: empty today must not stop a run
              note:
                ds.mutation === "null-field" ? null : `${i.owner} added this`,
              ...extra,
            };
            if (ds.mutation === "renamed") base.name = i.title;
            else base.title = i.title;
            return base;
          }),
          ...extra,
        },
        isError: false,
      };
    case "get_item": {
      const item = ds.items.find((i) => i.id === args.id);
      if (!item)
        return { value: `unknown item ${String(args.id)}`, isError: true };
      if (item.id === ds.failing)
        return { value: "upstream timeout", isError: true };
      const value: Record<string, unknown> = {
        id: item.id,
        owner: item.owner,
        ...extra,
      };
      // already empty in some recordings (a parcel with no estimate yet)
      value.eta = item.flag ? "2026-11-22" : null;
      if (ds.mutation !== "missing-field") value.body = item.body;
      return { value, isError: false };
    }
    case "find_by_email": {
      const found = ds.items.filter((i) => emailOf(i) === args.email);
      return {
        value: {
          items: found.map((i) => ({ id: i.id, owner: i.owner, ...extra })),
        },
        isError: false,
      };
    }
    case "get_weather":
      return {
        value: { city: args.city, summary: ds.weather, ...extra },
        isError: false,
      };
    case "get_stats":
      if (args.date !== ds.date) {
        return { value: `no stats for ${String(args.date)}`, isError: true };
      }
      return {
        value: { visits: ds.visits, signups: ds.signups, ...extra },
        isError: false,
      };
    case "send_message":
    case "archive_item":
      return { value: { ok: true }, isError: false };
    default:
      return { value: `unknown tool ${tool}`, isError: true };
  }
}

export type Call = (tool: string, args: Record<string, unknown>) => unknown;

/** What the agent writes for a task, from the values it read. */
export const text = {
  digest: (rows: Array<{ title: string; owner: string; body: string }>) =>
    rows.map((x) => `- ${x.title} (${x.owner}): ${x.body}`).join("\n"),
  fanin: (city: string, weather: string, visits: number, signups: number) =>
    `Weather in ${city}: ${weather}. Visits ${visits}, signups ${signups}.`,
  total: (n: number, sum: number) => `${n} items today, total ${sum} EUR.`,
  titles: (titles: string[]) => `New today: ${titles.join("; ")}`,
  lookup: (id: string, body: string) => `About ${id}: ${body}`,
};

export const KINDS = [
  "digest",
  "fanin",
  "total",
  "act",
  "maybe-send",
  // the customer gives an item id one day and an email the next: the first
  // step differs, and only the inputs tell the recordings apart
  "lookup",
] as const;
export type Kind = (typeof KINDS)[number];

const titleOf = (x: Record<string, unknown>) =>
  String(x.title ?? x.name ?? "?");

/**
 * The scripted agent: what a careful agent does for each kind of task. It
 * adapts to renamed fields and skips items it cannot read, so on mutated data
 * it shows what a correct run would have done.
 */
export function runAgent(kind: Kind, ds: Dataset, call: Call, r: Rand): void {
  const list = () =>
    (
      call("list_items", { date: ds.date }) as {
        items?: Array<Record<string, unknown>>;
      }
    )?.items ?? [];
  switch (kind) {
    case "digest": {
      const items = list();
      const rows: Array<{ title: string; owner: string; body: string }> = [];
      for (const it of items) {
        const got = call("get_item", { id: it.id }) as
          Record<string, unknown> | string;
        if (typeof got !== "object" || got === null) continue;
        rows.push({
          title: titleOf(it),
          owner: String(it.owner),
          body: String(got.body ?? "(no details)"),
        });
      }
      call("send_message", { to: "me", text: text.digest(rows) });
      return;
    }
    case "fanin": {
      const city = "Paris";
      const first = r() < 0.5;
      const w = first ? call("get_weather", { city }) : undefined;
      const s = call("get_stats", { date: ds.date }) as {
        visits: number;
        signups: number;
      };
      const w2 = (w ?? call("get_weather", { city })) as { summary: string };
      call("send_message", {
        to: "team",
        text: text.fanin(city, w2.summary, Number(s.visits), Number(s.signups)),
      });
      return;
    }
    case "total": {
      const items = list();
      const sum = items.reduce((a, x) => a + Number(x.amount), 0);
      call("send_message", {
        to: "finance",
        text: text.total(items.length, sum),
      });
      return;
    }
    case "act": {
      for (const it of list())
        if (it.flag === true) call("archive_item", { id: it.id });
      return;
    }
    case "lookup": {
      const given: { id?: string; email?: string } = ds.lookup ?? {};
      let id = given.id;
      if (given.email !== undefined) {
        const found = call("find_by_email", { email: given.email }) as {
          items?: Array<Record<string, unknown>>;
        };
        id = found?.items?.[0]?.id as string | undefined;
      }
      if (!id) return;
      const got = call("get_item", { id }) as Record<string, unknown> | string;
      if (typeof got !== "object" || got === null) return;
      call("send_message", {
        to: "customer",
        text: text.lookup(id, String(got.body ?? "(no details)")),
      });
      return;
    }
    case "maybe-send": {
      const items = list();
      if (items.length > 0)
        call("send_message", {
          to: "me",
          text: text.titles(items.map(titleOf)),
        });
      return;
    }
  }
}

/** Runs the agent on a dataset and returns its trace, as the recorder writes it. */
export function record(
  kind: Kind,
  ds: Dataset,
  r: Rand,
  noise: boolean,
): TraceFile {
  const calls: TraceFile["calls"] = [];
  const t0 = Date.parse(`${ds.date}T08:00:00Z`);
  const call: Call = (tool, args) => {
    const a = answer(ds, tool, args);
    calls.push({
      type: "tool_call",
      seq: calls.length + 1,
      tool,
      args,
      result: a.value,
      isError: a.isError,
      startedAt: new Date(t0 + calls.length * 1000).toISOString(),
      durationMs: 5,
    });
    return a.isError ? a.value : a.value;
  };
  // real agents sometimes look at something they end up not using
  if (noise) call("get_weather", { city: "Oslo" });
  runAgent(kind, ds, call, r);
  return {
    meta: {
      type: "meta",
      version: 1,
      task: `fuzz-${kind}`,
      startedAt: new Date(t0).toISOString(),
      server: "fuzz",
      inputs: inputsOf(ds),
      tools: TOOLS,
    },
    calls,
    end: {
      type: "end",
      endedAt: new Date(t0 + calls.length * 1000 + 500).toISOString(),
      toolCalls: calls.length,
    },
  };
}

export interface Effect {
  tool: string;
  args: Record<string, unknown>;
}

/** The side effects a correct run makes on this dataset. */
export function expectedEffects(kind: Kind, ds: Dataset, r: Rand): Effect[] {
  const effects: Effect[] = [];
  runAgent(
    kind,
    ds,
    (tool, args) => {
      if (SIDE_EFFECTS.has(tool)) effects.push({ tool, args });
      const a = answer(ds, tool, args);
      return a.value;
    },
    r,
  );
  return effects;
}

/**
 * A model that writes what the agent would, but only from what the prompt
 * shows it: an item whose id is not in the prompt is not mentioned, a value
 * the prompt lacks comes out as "?". A replay that forgets to read something
 * then produces a wrong message, and the fuzzer sees it.
 */
export function fakeModel(kind: Kind, ds: Dataset, prompt: string): string {
  const seen = (v: unknown) => prompt.includes(String(v));
  if (prompt.includes("Answer with one word: yes or no")) {
    return ds.items.some((i) => seen(i.id)) ? "yes" : "no";
  }
  const visible = ds.items.filter((i) => seen(i.id));
  switch (kind) {
    case "digest":
      return text.digest(
        visible
          .filter((i) => i.id !== ds.failing)
          .map((i) => ({
            title: seen(i.title) ? i.title : "?",
            owner: i.owner,
            body:
              ds.mutation === "missing-field"
                ? "(no details)"
                : seen(i.body)
                  ? i.body
                  : "?",
          })),
      );
    case "fanin":
      return text.fanin(
        "Paris",
        seen(ds.weather) ? ds.weather : "?",
        seen(ds.visits) ? ds.visits : NaN,
        seen(ds.signups) ? ds.signups : NaN,
      );
    case "total":
      return text.total(
        visible.length,
        visible.reduce((a, i) => a + i.amount, 0),
      );
    case "maybe-send":
      return text.titles(visible.map((i) => (seen(i.title) ? i.title : "?")));
    case "act":
      return "";
    case "lookup": {
      const item = visible.find((i) => i.id !== ds.failing);
      if (!item) return "";
      const body =
        ds.mutation === "missing-field"
          ? "(no details)"
          : seen(item.body)
            ? item.body
            : "?";
      return text.lookup(item.id, body);
    }
  }
}

/** Gives a dataset a lookup customer: by item id, or by the item's email. */
export function withLookup(ds: Dataset, byEmail: boolean, r: Rand): Dataset {
  // a customer always gives something; with no items it matches nothing
  if (ds.items.length === 0)
    return { ...ds, lookup: { email: "nobody@example.com" } };
  const item = pick(r, ds.items);
  return {
    ...ds,
    lookup: byEmail ? { email: emailOf(item) } : { id: item.id },
  };
}
