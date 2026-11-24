// "Flag every overdue invoice over 10,000": on the recording day only one invoice
// qualified, so the agent made one call, and the workflow flagged "invoice 6 of
// page 2" every day (hard bench, ap). One action on one item of a list becomes a
// loop when a rule on the items tells it apart from the rest, from numbers the
// agent wrote and dates the run was given; otherwise it stays as it was.
import { describe, expect, it } from "vitest";

import type { TraceFile } from "@hotpathrun/shared";

import { compileTrace, learnItemThresholdRule } from "../src/index.js";
import type { Feature } from "../src/rules.js";

const inv = (id: string, amount: number, due: string) => ({
  id,
  vendor: "Acme Cloud",
  amount,
  currency: "EUR",
  due_date: due,
});
const INVOICES = [
  inv("INV-1", 1200.5, "2026-10-02"), // overdue, small
  inv("INV-2", 13027.78, "2026-10-31"), // overdue, big: the one flagged
  inv("INV-3", 15400.1, "2026-11-20"), // big, not due yet
  inv("INV-4", 830.25, "2026-11-12"),
  inv("INV-5", 4999.99, "2026-09-15"), // overdue, small
];

function trace(text: string, flagged = "INV-2"): TraceFile {
  const calls = [
    {
      type: "tool_call" as const,
      seq: 1,
      tool: "list_invoices",
      args: {},
      result: { invoices: INVOICES, next_cursor: null },
      isError: false,
      startedAt: "2026-11-01T07:00:01.000Z",
      durationMs: 3,
    },
    {
      type: "tool_call" as const,
      seq: 2,
      tool: "flag_for_approval",
      args: { id: flagged },
      result: { ok: true },
      isError: false,
      startedAt: "2026-11-01T07:00:02.000Z",
      durationMs: 3,
    },
    {
      type: "tool_call" as const,
      seq: 3,
      tool: "send_message",
      args: { to: "controller", text },
      result: { ok: true },
      isError: false,
      startedAt: "2026-11-01T07:00:03.000Z",
      durationMs: 3,
    },
  ];
  return {
    meta: {
      type: "meta",
      version: 1,
      task: "ap",
      startedAt: "2026-11-01T07:00:00.000Z",
      server: "demo",
      inputs: { date: "2026-11-01" },
      tools: [
        {
          name: "list_invoices",
          inputSchema: {},
          annotations: { readOnlyHint: true },
        },
        { name: "flag_for_approval", inputSchema: {} },
        { name: "send_message", inputSchema: {} },
      ],
    },
    calls,
    end: {
      type: "end",
      endedAt: "2026-11-01T07:00:05.000Z",
      toolCalls: calls.length,
    },
  };
}

const WROTE =
  "Overdue report: 3 overdue invoices. Flagged INV-2 (13,027.78 EUR), the only overdue invoice over 10,000 EUR.";

describe("one action on one item of a list", () => {
  it("becomes a loop over the list with the rule the agent followed: overdue and over 10,000", () => {
    const wf = compileTrace(trace(WROTE), "t.jsonl");
    const loop = wf.steps.find((s) => s.type === "foreach");
    expect(loop).toMatchObject({
      type: "foreach",
      over: "{{steps.s1.result.invoices}}",
    });
    const body = loop!.type === "foreach" ? loop!.body[0]! : null;
    expect(body).toMatchObject({
      tool: "flag_for_approval",
      args: { id: `{{${loop!.type === "foreach" ? loop!.as : ""}.id}}` },
    });
    const as = loop!.type === "foreach" ? loop!.as : "";
    const when = loop!.type === "foreach" ? (loop!.when ?? body!.when) : null;
    expect(when).toEqual({
      kind: "all",
      of: expect.arrayContaining([
        { kind: "above", ref: `${as}.amount`, value: 10000 },
        { kind: "before", ref: `${as}.due_date`, other: "inputs.date" },
      ]),
    });
  });

  it("stays a plain step when the agent wrote no threshold that explains it", () => {
    const wf = compileTrace(
      trace("Overdue report: 3 overdue invoices. Flagged INV-2."),
      "t.jsonl",
    );
    expect(wf.steps.some((s) => s.type === "foreach")).toBe(false);
  });
});

describe("learnItemThresholdRule", () => {
  const item = (o: Record<string, number | string>) =>
    new Map<string, Feature>(
      Object.entries(o).map(([k, v]) => [`x.${k}`, { scalar: v }]),
    );
  const no = [
    item({ amount: 1200.5, due_date: "2026-10-02" }),
    item({ amount: 15400.1, due_date: "2026-11-20" }),
  ];
  const yes = [item({ amount: 13027.78, due_date: "2026-10-31" })];

  it("needs both parts only when neither alone separates the items", () => {
    expect(
      learnItemThresholdRule(yes, no, [10000], new Set(), {
        date: "2026-11-01",
      }),
    ).toEqual({
      kind: "all",
      of: [
        { kind: "above", ref: "x.amount", value: 10000 },
        { kind: "before", ref: "x.due_date", other: "inputs.date" },
      ],
    });
    // without the small overdue invoice, the date alone does not separate either,
    // but the amount alone would not: still both; with only the big future one,
    // the date alone is enough
    expect(
      learnItemThresholdRule(yes, [no[1]!], [10000], new Set(), {
        date: "2026-11-01",
      }),
    ).toEqual({ kind: "before", ref: "x.due_date", other: "inputs.date" });
  });

  it("prefers the round number the agent wrote over a total it calculated", () => {
    expect(
      learnItemThresholdRule(
        yes,
        [item({ amount: 1200.5, due_date: "2026-10-02" })],
        [12429.27, 10000],
        new Set(),
        {},
      ),
    ).toEqual({ kind: "above", ref: "x.amount", value: 10000 });
  });

  it("keeps 'overdue' with the amount when every flagged item is overdue and others are not", () => {
    // no big invoice still to come today: the amount alone separates, but the
    // date the run was given narrows it to what the agent did
    expect(
      learnItemThresholdRule(
        yes,
        [
          item({ amount: 1200.5, due_date: "2026-10-02" }),
          item({ amount: 830.25, due_date: "2026-11-12" }),
        ],
        [10000],
        new Set(),
        { date: "2026-11-01" },
      ),
    ).toEqual({
      kind: "all",
      of: [
        { kind: "above", ref: "x.amount", value: 10000 },
        { kind: "before", ref: "x.due_date", other: "inputs.date" },
      ],
    });
  });

  it("learns nothing from a number the agent never wrote", () => {
    expect(learnItemThresholdRule(yes, [no[0]!], [], new Set(), {})).toBeNull();
  });
});
