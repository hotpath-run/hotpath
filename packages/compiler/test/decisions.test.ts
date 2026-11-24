// Per-item decisions (rule 12): the agent acted on each item of a list, and what it
// did (which action, which values) depended on the item. Found by the hard-workflow
// tests: CRM tiering, ticket routing and expense filing compiled into a fixed list of
// calls by position with the recorded values typed in, so a new day wrote last week's
// decisions against new items and reported success.
import { describe, expect, it } from "vitest";

import {
  workflowSchema,
  type ForeachStep,
  type TraceFile,
  type TraceToolCall,
  type Workflow,
} from "@hotpathrun/shared";

import {
  compileTrace,
  compileTraceDetailed,
  formatWorkflow,
} from "../src/index.js";

let seq = 0;
function call(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): TraceToolCall {
  seq++;
  return {
    type: "tool_call",
    seq,
    tool,
    args,
    result,
    isError: false,
    startedAt: "2026-11-01T07:00:00.000Z",
    durationMs: 5,
  };
}

function trace(
  calls: TraceToolCall[],
  tools: Array<[string, boolean]>,
): TraceFile {
  return {
    meta: {
      type: "meta",
      version: 1,
      task: "crm",
      startedAt: "2026-11-01T07:00:00.000Z",
      server: "demo",
      inputs: { date: "2026-11-01" },
      tools: tools.map(([name, readOnly]) => ({
        name,
        inputSchema: {},
        annotations: { readOnlyHint: readOnly },
      })),
    },
    calls,
    end: {
      type: "end",
      endedAt: "2026-11-01T07:00:05.000Z",
      toolCalls: calls.length,
    },
  };
}

const leads = [
  { id: "L1", company_domain: "big.example" },
  { id: "L2", company_domain: "mid.example" },
  { id: "L3", company_domain: "tiny.example" },
  { id: "L4", company_domain: "huge.example" },
];
const companies = [
  { domain: "big.example", headcount: 4200 },
  { domain: "mid.example", headcount: 380 },
  { domain: "tiny.example", headcount: 12 },
  { domain: "huge.example", headcount: 9100 },
];
const tiers = ["enterprise", "mid", "smb", "enterprise"];

function crmTrace(): TraceFile {
  return trace(
    [
      call("list_leads", { page: 1 }, { leads }),
      ...companies.map((c, i) =>
        call("get_company", { domain: leads[i]!.company_domain }, c),
      ),
      ...leads.map((l, i) =>
        call("update_lead", { id: l.id, tier: tiers[i] }, { ok: true }),
      ),
    ],
    [
      ["list_leads", true],
      ["get_company", true],
      ["update_lead", false],
    ],
  );
}

const decisionLoop = (wf: Workflow): ForeachStep | undefined =>
  wf.steps.find(
    (s): s is ForeachStep => s.type === "foreach" && s.decide !== undefined,
  );

describe("per-item decisions", () => {
  it("compiles an action whose value depends on the item into a loop with a decision, not one call per position", () => {
    const wf = compileTrace(crmTrace(), "t");
    expect(() => workflowSchema.parse(wf)).not.toThrow();
    const loop = decisionLoop(wf);
    expect(loop).toBeDefined();
    expect(loop!.over).toBe("{{steps.s1.result.leads}}");
    expect(loop!.body).toHaveLength(1);
    const update = loop!.body[0]!;
    expect(update.tool).toBe("update_lead");
    expect(update.args).toEqual({
      id: `{{${loop!.as}.id}}`,
      tier: "{{choice.tier}}",
    });
    expect(update.when).toEqual({
      kind: "equals",
      ref: "choice.action",
      value: "update_lead",
    });
    expect(loop!.decide!.actions).toEqual([
      { tool: "update_lead", fields: { tier: "string" } },
    ]);
    // nothing indexed by position is left: no step points at leads.0, leads.1, …
    expect(JSON.stringify(wf.steps)).not.toMatch(/leads\.\d/);
  });

  it("keeps the recorded decisions as examples, with each item's looked-up details", () => {
    const loop = decisionLoop(compileTrace(crmTrace(), "t"))!;
    const examples = loop.decide!.examples;
    expect(examples).toHaveLength(4);
    expect(examples[0]).toEqual({
      item: leads[0],
      details: companies[0],
      choice: { action: "update_lead", tier: "enterprise" },
    });
    expect(examples[2]!.choice).toEqual({ action: "update_lead", tier: "smb" });
    // the decision reads this run's data: the lookups are templates, not recorded values
    expect(loop.decide!.prompt).toContain("{{steps.s2.results}}");
    expect(loop.decide!.prompt).not.toContain("4200");
    expect(loop.decide!.key).toEqual(["id"]);
  });

  it("routes items to different actions, and marks the items nothing was done to", () => {
    const tickets = [
      { id: "T1", category: "billing", amount: 20 },
      { id: "T2", category: "bug" },
      { id: "T3", category: "question" },
      { id: "T4", category: "billing", amount: 400 },
    ];
    const tr = trace(
      [
        call("list_tickets", { status: "open" }, { tickets }),
        call("issue_refund", { id: "T1", amount: 20 }, { ok: true }),
        call("escalate", { id: "T2" }, { ok: true }),
        // T3: nothing done
        call(
          "forward_to_finance",
          { ticket_id: "T4", note: "over the refund limit" },
          { ok: true },
        ),
      ],
      [
        ["list_tickets", true],
        ["issue_refund", false],
        ["escalate", false],
        ["forward_to_finance", false],
      ],
    );
    const wf = compileTrace(tr, "t");
    expect(() => workflowSchema.parse(wf)).not.toThrow();
    const loop = decisionLoop(wf)!;
    expect(loop.body.map((b) => b.tool)).toEqual([
      "issue_refund",
      "escalate",
      "forward_to_finance",
    ]);
    const as = loop.as;
    // the amount is the ticket's own field: code fills it in, the model is not asked
    expect(loop.body[0]!.args).toEqual({
      id: `{{${as}.id}}`,
      amount: `{{${as}.amount}}`,
    });
    expect(loop.body[1]!.args).toEqual({ id: `{{${as}.id}}` });
    // one recorded call: its note is a constant until another recording varies it
    expect(loop.body[2]!.args).toEqual({
      ticket_id: `{{${as}.id}}`,
      note: "over the refund limit",
    });
    expect(loop.decide!.actions).toEqual([
      { tool: "issue_refund", fields: {} },
      { tool: "escalate", fields: {} },
      { tool: "forward_to_finance", fields: {} },
    ]);
    expect(loop.decide!.examples.map((e) => e.choice.action)).toEqual([
      "issue_refund",
      "escalate",
      "none",
      "forward_to_finance",
    ]);
  });

  it("leaves a plain loop alone when every item got the same action", () => {
    const tr = trace(
      [
        call("list_leads", { page: 1 }, { leads }),
        ...leads.map((l) =>
          call("update_lead", { id: l.id, tier: "reviewed" }, { ok: true }),
        ),
      ],
      [
        ["list_leads", true],
        ["update_lead", false],
      ],
    );
    const wf = compileTrace(tr, "t");
    expect(decisionLoop(wf)).toBeUndefined();
    const loop = wf.steps.find((s) => s.type === "foreach") as ForeachStep;
    expect(loop.body[0]!.args).toEqual({
      id: `{{${loop.as}.id}}`,
      tier: "reviewed",
    });
  });

  it("shows the decision in hotpath show", () => {
    const text = formatWorkflow(compileTrace(crmTrace(), "t"));
    expect(text).toMatch(/decide per lead/);
    expect(text).toMatch(
      /update_lead\(id=\{\{lead\.id\}\}, tier=\{\{choice\.tier\}\}\).*only if choice\.action is "update_lead"/,
    );
  });
});

describe("actions repeated by position", () => {
  it("are reported when they can't become a loop, so the workflow is never replayed with them", () => {
    // two actions on items 0 and 1 of a list, then a third call to a different
    // list in between: no single run of per-item actions
    const tr = trace(
      [
        call("list_leads", { page: 1 }, { leads }),
        call("update_lead", { id: "L1", tier: "enterprise" }, { ok: true }),
        call(
          "list_leads",
          { page: 2 },
          { leads: [{ id: "L9", company_domain: "x.example" }] },
        ),
        call("update_lead", { id: "L2", tier: "mid" }, { ok: true }),
      ],
      [
        ["list_leads", true],
        ["update_lead", false],
      ],
    );
    const { workflow } = compileTraceDetailed(tr, "t");
    expect(workflow.positional).toEqual([
      expect.objectContaining({
        list: "steps.s1.result.leads",
        steps: ["s2", "s4"],
      }),
    ]);
  });
});

describe("compile output", () => {
  it("tells the owner what is decided per item, and refuses positional actions loudly", async () => {
    const { decisionNotes, positionalWarnings } =
      await import("../src/compile-task.js");
    const notes = decisionNotes(compileTrace(crmTrace(), "t"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(
      /each lead is decided by the replay model.*update_lead ×4/,
    );
    const wf = {
      ...compileTrace(crmTrace(), "t"),
      positional: [{ list: "steps.s1.result.leads", steps: ["s2", "s4"] }],
    };
    expect(positionalWarnings(wf)[0]).toMatch(/never replayed/);
  });
});

describe("item rules never use an identifier", () => {
  it("does not learn 'act when the id is T200', even when every recording acted on a T200", async () => {
    const { features, learnItemRule } = await import("../src/rules.js");
    const f = (item: Record<string, unknown>) => {
      const out = new Map();
      features(item, "ticket", out);
      return out;
    };
    // the same id came back on several days, with a different category each time
    const yes = [
      f({ id: "T200", category: "billing" }),
      f({ id: "T200", category: "bug" }),
    ];
    const no = [
      f({ id: "T201", category: "billing" }),
      f({ id: "T202", category: "bug" }),
    ];
    expect(learnItemRule(yes, no)).toBeNull();
    // a real rule on the same items is still learned
    const urgent = [
      f({ id: "T1", priority: "high" }),
      f({ id: "T2", priority: "high" }),
    ];
    const calm = [
      f({ id: "T3", priority: "low" }),
      f({ id: "T4", priority: "low" }),
    ];
    expect(learnItemRule(urgent, calm)).toEqual({
      kind: "equals",
      ref: "ticket.priority",
      value: "high",
    });
  });
});

describe("a lookup once per distinct value", () => {
  it("compiles one call per distinct product into a loop over the orders that skips repeats, not one call per position", () => {
    const orders = [
      { id: "O1", sku: "SKU-C", qty: 2 },
      { id: "O2", sku: "SKU-F", qty: 2 },
      { id: "O3", sku: "SKU-C", qty: 5 },
      { id: "O4", sku: "SKU-A", qty: 1 },
      { id: "O5", sku: "SKU-F", qty: 3 },
    ];
    const stock: Record<string, number> = {
      "SKU-C": 6,
      "SKU-F": 0,
      "SKU-A": 9,
    };
    const tr = trace(
      [
        call("list_orders", { status: "paid" }, { orders }),
        ...["SKU-C", "SKU-F", "SKU-A"].map((sku) =>
          call("check_stock", { sku }, { sku, on_hand: stock[sku] }),
        ),
        call("create_shipment", { order_id: "O1" }, { ok: true }),
        call("backorder", { order_id: "O2" }, { ok: true }),
        call("create_shipment", { order_id: "O3" }, { ok: true }),
        call("create_shipment", { order_id: "O4" }, { ok: true }),
        call("backorder", { order_id: "O5" }, { ok: true }),
      ],
      [
        ["list_orders", true],
        ["check_stock", true],
        ["create_shipment", false],
        ["backorder", false],
      ],
    );
    const wf = compileTrace(tr, "t");
    expect(() => workflowSchema.parse(wf)).not.toThrow();
    const lookup = wf.steps[1] as ForeachStep;
    expect(lookup.type).toBe("foreach");
    expect(lookup.over).toBe("{{steps.s1.result.orders}}");
    expect(lookup.distinct).toEqual(["sku"]);
    expect(lookup.body[0]!.args).toEqual({ sku: "{{order.sku}}" });
    expect(JSON.stringify(wf.steps)).not.toMatch(/orders\.\d/);
    expect(decisionLoop(wf)?.decide?.actions.map((a) => a.tool)).toEqual([
      "create_shipment",
      "backorder",
    ]);
  });
});

describe("a summary after the decisions", () => {
  it("is written from the run's decisions, not guessed from the recorded example", () => {
    const tr = crmTrace();
    tr.calls.push(
      call(
        "send_message",
        {
          to: "sales",
          text: "Tiering done for 4 leads: enterprise 2 (L1, L4), mid 1 (L2), smb 1 (L3). All CRM records updated.",
        },
        { ok: true },
      ),
    );
    tr.meta.tools.push({
      name: "send_message",
      inputSchema: {},
      annotations: { readOnlyHint: false },
    });
    const wf = compileTrace(tr, "t");
    const loop = decisionLoop(wf)!;
    const writer = wf.steps.find((s) => s.type === "llm");
    expect(writer?.type === "llm" && writer.prompt).toContain(
      `{{steps.${loop.id}.results}}`,
    );
  });
});

describe("a read-only lookup in any order", () => {
  it("is one loop per distinct value even when the agent looked things up out of order and twice", () => {
    const orders = [
      { id: "O1", sku: "SKU-C" },
      { id: "O2", sku: "SKU-F" },
      { id: "O3", sku: "SKU-A" },
      { id: "O4", sku: "SKU-F" },
    ];
    const tr = trace(
      [
        call("list_orders", {}, { orders }),
        // out of order, F twice
        ...["SKU-F", "SKU-C", "SKU-F", "SKU-A"].map((sku) =>
          call("check_stock", { sku }, { sku, on_hand: 1 }),
        ),
        call("create_shipment", { order_id: "O1" }, { ok: true }),
        call("backorder", { order_id: "O2" }, { ok: true }),
      ],
      [
        ["list_orders", true],
        ["check_stock", true],
        ["create_shipment", false],
        ["backorder", false],
      ],
    );
    const wf = compileTrace(tr, "t");
    const lookup = wf.steps[1] as ForeachStep;
    expect(lookup.type).toBe("foreach");
    expect(lookup.distinct).toEqual(["sku"]);
    expect(JSON.stringify(wf.steps)).not.toMatch(/orders\.\d/);
  });
});
