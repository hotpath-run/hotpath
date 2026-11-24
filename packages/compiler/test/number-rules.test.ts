// "Page the on-call only if the error rate is above 2%": a step one recording made
// and another did not, told apart by a number. One recording per side is enough
// when the agent wrote the threshold itself ("above the 2% threshold"); a number it
// never wrote is no rule (a request count that happened to be higher). Measured: a
// workflow recorded on an alert day paged every day (hard bench, threshold 3/4 wrong).
import { describe, expect, it } from "vitest";

import type { TraceFile } from "@hotpathrun/shared";

import { compileTraces, learnNumberRule } from "../src/index.js";
import type { Feature } from "../src/rules.js";

const f = (o: Record<string, number>) =>
  new Map<string, Feature>(
    Object.entries(o).map(([k, v]) => [k, { scalar: v }]),
  );

describe("learnNumberRule", () => {
  const rate = "steps.s1.result.metrics.error_rate_pct";
  const reqs = "steps.s1.result.metrics.requests";

  it("learns above N from one run per side when the agent wrote N", () => {
    expect(
      learnNumberRule(
        [f({ [rate]: 3.1, [reqs]: 50000 })],
        [f({ [rate]: 0.4, [reqs]: 20000 })],
        [3.1, 2, 779],
        new Set([3.1, 0.4, 50000, 20000, 779]),
      ),
    ).toEqual({ kind: "above", ref: rate, value: 2 });
  });

  it("learns below N the same way", () => {
    expect(
      learnNumberRule(
        [f({ "steps.s1.result.stock": 3 })],
        [f({ "steps.s1.result.stock": 40 })],
        [10],
        new Set([3, 40]),
      ),
    ).toEqual({ kind: "below", ref: "steps.s1.result.stock", value: 10 });
  });

  it("learns nothing from one run per side when the agent wrote no threshold", () => {
    expect(
      learnNumberRule(
        [f({ [rate]: 3.1 })],
        [f({ [rate]: 0.4 })],
        [3.1],
        new Set([3.1, 0.4]),
      ),
    ).toBeNull();
  });

  it("never takes a number from the data as the threshold", () => {
    // 30000 is another field's value: it falls between the request counts by chance
    expect(
      learnNumberRule(
        [f({ [reqs]: 50000, x: 30000 })],
        [f({ [reqs]: 20000, x: 30000 })],
        [30000],
        new Set([50000, 20000, 30000]),
      ),
    ).toBeNull();
  });

  it("with three runs or more per side, takes the middle when no threshold was written", () => {
    expect(
      learnNumberRule(
        [f({ [rate]: 3.1 }), f({ [rate]: 4.7 }), f({ [rate]: 5 })],
        [f({ [rate]: 0.4 }), f({ [rate]: 0.9 }), f({ [rate]: 1.3 })],
        [],
        new Set([3.1, 4.7, 5, 0.4, 0.9, 1.3]),
      ),
    ).toEqual({ kind: "above", ref: rate, value: 2.2 });
  });
});

// two recordings of the threshold task: an alert day (paged) and a calm one
function trace(rate: number, p95: number, paged: boolean): TraceFile {
  const metrics = {
    service: "checkout",
    p95_ms: p95,
    error_rate_pct: rate,
    requests: paged ? 61000 : 23000,
  };
  const calls = [
    {
      type: "tool_call",
      seq: 1,
      tool: "get_metrics",
      args: {},
      result: { metrics },
      isError: false,
      startedAt: "2026-11-01T07:00:01.000Z",
      durationMs: 3,
    },
    ...(paged
      ? [
          {
            type: "tool_call",
            seq: 2,
            tool: "page_oncall",
            args: {
              summary: `Checkout error rate is ${rate}%, above the 2% threshold.`,
            },
            result: { ok: true },
            isError: false,
            startedAt: "2026-11-01T07:00:02.000Z",
            durationMs: 3,
          },
        ]
      : []),
    {
      type: "tool_call",
      seq: 3,
      tool: "send_message",
      args: {
        to: "me",
        text: `Checkout status: p95_ms=${p95}, error_rate_pct=${rate}${paged ? "; on-call paged" : ""}.`,
      },
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
      task: "threshold",
      startedAt: "2026-11-01T07:00:00.000Z",
      server: "demo",
      inputs: {},
      tools: [
        {
          name: "get_metrics",
          inputSchema: {},
          annotations: { readOnlyHint: true },
        },
        { name: "page_oncall", inputSchema: {} },
        { name: "send_message", inputSchema: {} },
      ],
    },
    calls,
    end: {
      type: "end",
      endedAt: "2026-11-01T07:00:05.000Z",
      toolCalls: calls.length,
    },
  } as TraceFile;
}

describe("compiling a calm day and an alert day", () => {
  it("pages only above the threshold the agent wrote, and still sends the status every day", () => {
    const { workflow } = compileTraces(
      [trace(0.4, 310, false), trace(3.1, 779, true)],
      "t.jsonl",
    );
    const page = workflow.steps.find(
      (s) => s.type === "tool" && s.tool === "page_oncall",
    );
    expect(page?.when).toEqual({
      kind: "above",
      ref: "steps.s1.result.metrics.error_rate_pct",
      value: 2,
    });
    const status = workflow.steps.find(
      (s) => s.type === "tool" && s.tool === "send_message",
    );
    expect(status?.when).toBeUndefined();
  });
});
