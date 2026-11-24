// Per-item decisions at run time: the replay model decides, for every item at once,
// which recorded action to take and with which values; code checks the answer before
// any action runs. A wrong-shaped answer is drift with nothing done.
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import { chat, type ItemDecision, type Workflow } from "@hotpathrun/shared";
import { DriftError, runWorkflow } from "../src/index.js";
import {
  compareDecisions,
  decisionPrompt,
  parseDecisions,
} from "../src/decisions.js";

/** A model that answers per item from a table, in the order the prompt lists them. */
function answering(byId: Record<string, Record<string, unknown>>) {
  return (req: { messages: Array<{ content: string }> }) => {
    const ids = [...req.messages[0]!.content.matchAll(/^\d+\. (\S+):/gm)].map(
      (m) => m[1]!,
    );
    return Promise.resolve({
      text: JSON.stringify(ids.map((id) => ({ id, ...byId[id] }))),
      llmCalls: 1,
      promptTokens: 10,
      completionTokens: 10,
    } as Awaited<ReturnType<typeof chat>>);
  };
}

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const actionsFile = path.join(repoRoot, "out", "actions.json");

const decide: ItemDecision = {
  model: "cheap",
  prompt:
    'You are replaying the task "sweep".\n\ns1 get_mailbox result:\n{{steps.s1.result}}',
  key: ["id"],
  actions: [
    { tool: "archive", fields: {} },
    { tool: "page_oncall", fields: { note: "string" } },
  ],
  examples: [
    {
      item: { id: "x1", subject: "Free cruise", category: "spam" },
      choice: { action: "archive" },
    },
    {
      item: { id: "x2", subject: "DB down", category: "urgent" },
      choice: { action: "page_oncall", note: "DB down" },
    },
    {
      item: { id: "x3", subject: "Lunch?", category: "normal" },
      choice: { action: "none" },
    },
  ],
};

const items = [
  { id: "e1", subject: "Win a free cruise", category: "spam" },
  { id: "e2", subject: "Q3 budget review", category: "normal" },
];

describe("parseDecisions", () => {
  it("accepts one decision per item, in order, with the fields its action needs", () => {
    const r = parseDecisions(
      '```json\n[{"id":"e1","action":"archive"},{"id":"e2","action":"none"}]\n```',
      items,
      decide,
    );
    expect(r).toEqual({
      ok: true,
      decisions: [
        { id: "e1", action: "archive" },
        { id: "e2", action: "none" },
      ],
    });
  });

  it("refuses a missing item, an unknown action, a missing field or a wrong type", () => {
    const bad = [
      [
        '[{"id":"e1","action":"archive"}]',
        /one decision per item: 2 items, 1 decision/,
      ],
      [
        '[{"id":"e1","action":"delete"},{"id":"e2","action":"none"}]',
        /e1: "delete" is not one of archive, page_oncall, none/,
      ],
      [
        '[{"id":"e1","action":"page_oncall"},{"id":"e2","action":"none"}]',
        /e1: page_oncall needs note \(string\)/,
      ],
      [
        '[{"id":"e1","action":"page_oncall","note":7},{"id":"e2","action":"none"}]',
        /e1: page_oncall needs note \(string\)/,
      ],
      [
        '[{"id":"e2","action":"none"},{"id":"e1","action":"archive"}]',
        /decision 1 is for e2, item 1 is e1/,
      ],
      ["I would archive the first one.", /not a JSON list/],
    ] as const;
    for (const [text, why] of bad) {
      const r = parseDecisions(text, items, decide);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.error).toMatch(why);
    }
  });

  it("checks numbers are numbers", () => {
    const money: ItemDecision = {
      ...decide,
      actions: [{ tool: "issue_refund", fields: { amount: "number" } }],
    };
    const r = parseDecisions(
      '[{"id":"e1","action":"issue_refund","amount":"20"},{"id":"e2","action":"none"}]',
      items,
      money,
    );
    expect(r.ok).toBe(false);
  });
});

describe("decisionPrompt", () => {
  it("gives the run's data, the items by key, the recorded decisions and the answer format", () => {
    const text = decisionPrompt(decide, items, "email", {
      inputs: {},
      steps: { s1: { result: { emails: items } } },
    });
    expect(text).toContain("Win a free cruise");
    expect(text).toContain("1. e1");
    expect(text).toContain('"action":"page_oncall","note":"DB down"');
    expect(text).toMatch(/archive \| page_oncall \(note: string\) \| none/);
    expect(text).toMatch(/JSON list/);
  });
});

function sweepWorkflow(): Workflow {
  return {
    version: 1,
    task: "decision-test",
    compiledFrom: "test",
    server: "triage",
    serverArgv: [
      process.execPath,
      "--import",
      "tsx",
      path.join(repoRoot, "examples/demo-tools/src/triage.ts"),
    ],
    cwd: repoRoot,
    inputs: {},
    steps: [
      {
        id: "s1",
        type: "tool",
        tool: "get_mailbox",
        args: { date: "2026-10-01" },
        sideEffect: false,
        guard: {},
      },
      {
        id: "s2",
        type: "foreach",
        over: "{{steps.s1.result.emails}}",
        as: "email",
        decide,
        body: [
          {
            id: "s2.1",
            type: "tool",
            tool: "archive",
            args: { id: "{{email.id}}" },
            sideEffect: true,
            guard: {},
            when: { kind: "equals", ref: "choice.action", value: "archive" },
          },
          {
            id: "s2.2",
            type: "tool",
            tool: "page_oncall",
            args: { subject: "{{choice.note}}" },
            sideEffect: true,
            guard: {},
            when: {
              kind: "equals",
              ref: "choice.action",
              value: "page_oncall",
            },
          },
        ],
        maxItems: 50,
      },
    ],
  };
}

const actions = async () => {
  try {
    return JSON.parse(await readFile(actionsFile, "utf8")) as Array<
      Record<string, unknown>
    >;
  } catch {
    return [];
  }
};

describe("a loop with a decision", () => {
  const before = process.env.DEMO_FIXTURES;
  beforeEach(async () => {
    process.env.DEMO_FIXTURES = "sweep-a";
    process.env.HOTPATH_JOURNAL = "0";
    await rm(actionsFile, { force: true });
  });
  afterEach(async () => {
    if (before === undefined) delete process.env.DEMO_FIXTURES;
    else process.env.DEMO_FIXTURES = before;
    delete process.env.HOTPATH_JOURNAL;
    vi.mocked(chat).mockReset();
    await rm(actionsFile, { force: true });
  });

  async function mailbox(): Promise<
    Array<{ id: string; category: string; subject: string }>
  > {
    const raw = await readFile(
      path.join(repoRoot, "examples/demo-tools/fixtures/sweep-a/triage.json"),
      "utf8",
    );
    return (
      JSON.parse(raw) as {
        mailbox: Array<{ id: string; category: string; subject: string }>;
      }
    ).mailbox;
  }

  it("asks once for all items, then does each item's action", async () => {
    const box = await mailbox();
    const answer = box.map((m) =>
      m.category === "spam"
        ? { id: m.id, action: "archive" }
        : m.category === "urgent"
          ? { id: m.id, action: "page_oncall", note: m.subject }
          : { id: m.id, action: "none" },
    );
    vi.mocked(chat).mockImplementation(
      answering(
        Object.fromEntries(answer.map(({ id, ...d }) => [id, d])),
      ) as never,
    );
    const metrics = await runWorkflow(sweepWorkflow(), { inputs: {} });
    // asked twice, the second time with the items in reverse order
    expect(vi.mocked(chat)).toHaveBeenCalledTimes(2);
    expect(metrics.llmCalls).toBe(2);
    const order = (n: number) =>
      [
        ...(
          vi.mocked(chat).mock.calls[n]![0].messages[0]!.content as string
        ).matchAll(/^\d+\. (\S+):/gm),
      ].map((m) => m[1]);
    expect(order(1)).toEqual([...order(0)].reverse());
    const done = await actions();
    expect(done.filter((a) => a.kind === "archive").map((a) => a.id)).toEqual(
      box.filter((m) => m.category === "spam").map((m) => m.id),
    );
    expect(
      done.filter((a) => a.kind === "page_oncall").map((a) => a.subject),
    ).toEqual(box.filter((m) => m.category === "urgent").map((m) => m.subject));
  });

  it("stops before any action when the two answers differ, naming the item and both answers", async () => {
    const box = await mailbox();
    const first = Object.fromEntries(
      box.map((m) => [
        m.id,
        m.category === "spam" ? { action: "archive" } : { action: "none" },
      ]),
    );
    const flipped = box.find((m) => m.category !== "spam")!;
    const second = { ...first, [flipped.id]: { action: "archive" } };
    const firstAsk = answering(first);
    const secondAsk = answering(second);
    vi.mocked(chat)
      .mockImplementationOnce(firstAsk as never)
      .mockImplementationOnce(secondAsk as never);
    const err = await runWorkflow(sweepWorkflow(), { inputs: {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DriftError);
    expect((err as DriftError).sideEffectRan).toBe(false);
    expect((err as DriftError).reason).toMatch(/two different answers/);
    expect((err as DriftError).reason).toContain(
      `${flipped.id}: none vs archive`,
    );
    expect(await actions()).toEqual([]);
  });

  it("asks once with HOTPATH_DECIDE_TWICE=0", async () => {
    const box = await mailbox();
    vi.mocked(chat).mockImplementation(
      answering(
        Object.fromEntries(box.map((m) => [m.id, { action: "none" }])),
      ) as never,
    );
    process.env.HOTPATH_DECIDE_TWICE = "0";
    try {
      await runWorkflow(sweepWorkflow(), { inputs: {} });
    } finally {
      delete process.env.HOTPATH_DECIDE_TWICE;
    }
    expect(vi.mocked(chat)).toHaveBeenCalledTimes(1);
  });

  it("stops before any action when the answer is wrong, after one retry", async () => {
    vi.mocked(chat).mockResolvedValue({
      text: '[{"id":"e1","action":"archive"}]',
      llmCalls: 1,
      promptTokens: 10,
      completionTokens: 10,
    } as Awaited<ReturnType<typeof chat>>);
    const err = await runWorkflow(sweepWorkflow(), { inputs: {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DriftError);
    expect((err as DriftError).sideEffectRan).toBe(false);
    expect((err as DriftError).reason).toMatch(/one decision per item/);
    expect(vi.mocked(chat)).toHaveBeenCalledTimes(2);
    expect(await actions()).toEqual([]);
  });
});

describe("a workflow with actions repeated by position", () => {
  it("never replays: the agent runs instead", async () => {
    const wf: Workflow = {
      ...sweepWorkflow(),
      steps: [sweepWorkflow().steps[0]!],
      positional: [{ list: "steps.s1.result.emails", steps: ["s2", "s3"] }],
    };
    const err = await runWorkflow(wf, { inputs: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriftError);
    expect((err as DriftError).sideEffectRan).toBe(false);
    expect((err as DriftError).reason).toMatch(/by position/);
  });
});

describe("a loop once per distinct value", () => {
  it("runs the body once per distinct value and skips repeats", async () => {
    const before = process.env.DEMO_FIXTURES;
    process.env.DEMO_FIXTURES = "sweep-a";
    try {
      const raw = await readFile(
        path.join(repoRoot, "examples/demo-tools/fixtures/sweep-a/triage.json"),
        "utf8",
      );
      const box = (JSON.parse(raw) as { mailbox: Array<{ category: string }> })
        .mailbox;
      const distinct = [...new Set(box.map((m) => m.category))];
      expect(distinct.length).toBeLessThan(box.length);
      const wf: Workflow = {
        ...sweepWorkflow(),
        steps: [
          sweepWorkflow().steps[0]!,
          {
            id: "s2",
            type: "foreach",
            over: "{{steps.s1.result.emails}}",
            as: "email",
            distinct: ["category"],
            body: [
              {
                id: "s2.1",
                type: "tool",
                tool: "get_mailbox",
                args: { date: "{{email.category}}" },
                sideEffect: false,
                guard: {},
              },
            ],
            maxItems: 50,
          },
        ],
      };
      const metrics = await runWorkflow(wf, { inputs: {} });
      const lookups = metrics.toolCalls.slice(1).map((c) => c.args.date);
      expect(lookups).toEqual(distinct);
    } finally {
      if (before === undefined) delete process.env.DEMO_FIXTURES;
      else process.env.DEMO_FIXTURES = before;
    }
  });
});

describe("asking a second time", () => {
  it("lists the items in another order, each still next to its own details", () => {
    const spec: ItemDecision = { ...decide, details: { step: "s2" } };
    const ctx = {
      inputs: {},
      steps: {
        s1: { result: { emails: items } },
        s2: { results: [{ from: "spam.biz" }, { from: "corp.com" }] },
      },
    };
    const text = decisionPrompt(spec, items, "email", ctx, [1, 0]);
    expect(text.indexOf("1. e2")).toBeGreaterThan(-1);
    expect(text.indexOf("1. e2")).toBeLessThan(text.indexOf("2. e1"));
    expect(text).toContain(
      '2. e1: {"id":"e1","subject":"Win a free cruise","category":"spam"} details {"from":"spam.biz"}',
    );
    expect(text).toContain('"id":"e2"');
  });

  it("compares the action and the values it needs, ignoring case, spacing and extra keys", () => {
    const a = [
      { id: "e1", action: "page_oncall", note: "DB  down" },
      { id: "e2", action: "none", why: "normal" },
    ];
    const same = [
      { id: "e1", action: "page_oncall", note: "db down " },
      { id: "e2", action: "none", why: "it is normal" },
    ];
    expect(compareDecisions(a, same, items, decide)).toEqual([]);
    const other = [
      { id: "e1", action: "page_oncall", note: "disk full" },
      { id: "e2", action: "archive" },
    ];
    expect(compareDecisions(a, other, items, decide)).toEqual([
      'e1: page_oncall {"note":"DB  down"} vs page_oncall {"note":"disk full"}',
      "e2: none vs archive",
    ]);
  });

  it("treats numbers within rounding as the same", () => {
    const spec: ItemDecision = {
      ...decide,
      actions: [{ tool: "refund", fields: { amount: "number" } }],
    };
    const one = [{ id: "e1", action: "refund", amount: 12.5 }];
    expect(
      compareDecisions(
        one,
        [{ id: "e1", action: "refund", amount: 12.5000001 }],
        [items[0]],
        spec,
      ),
    ).toEqual([]);
    expect(
      compareDecisions(
        one,
        [{ id: "e1", action: "refund", amount: 13 }],
        [items[0]],
        spec,
      ),
    ).toHaveLength(1);
  });
});

describe("each item with its own details", () => {
  it("puts every item next to its looked-up data, also when the lookup ran once per distinct value", () => {
    const spec: ItemDecision = {
      ...decide,
      key: ["id"],
      details: { step: "s2", distinct: ["sku"] },
      actions: [
        { tool: "create_shipment", fields: {} },
        { tool: "backorder", fields: {} },
      ],
    };
    const orders = [
      { id: "O1", sku: "SKU-C", qty: 2 },
      { id: "O2", sku: "SKU-F", qty: 2 },
      { id: "O3", sku: "SKU-C", qty: 9 },
    ];
    const ctx = {
      inputs: {},
      steps: {
        s1: { result: { orders } },
        // one result per distinct sku, in the order the skus first appear
        s2: {
          results: [
            { sku: "SKU-C", on_hand: 6 },
            { sku: "SKU-F", on_hand: 0 },
          ],
        },
      },
    };
    const text = decisionPrompt(spec, orders, "order", ctx);
    expect(text).toContain(
      '3. O3: {"id":"O3","sku":"SKU-C","qty":9} details {"sku":"SKU-C","on_hand":6}',
    );
    expect(text).toContain(
      '2. O2: {"id":"O2","sku":"SKU-F","qty":2} details {"sku":"SKU-F","on_hand":0}',
    );
  });
});
