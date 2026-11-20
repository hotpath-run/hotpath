// Found by the fuzzer: a loop's `get_item` result had `eta` null in every item
// of the newest recording and a date in some items of the older one. The guard
// came from the newest recording alone ("eta must be null"), so the workflow
// stopped on data it was compiled from.
import { describe, expect, it } from "vitest";

import {
  workflowSchema,
  type TraceFile,
  type TraceToolCall,
  type Workflow,
} from "@hotpathrun/shared";

import { compileTraces, inferCommonSchema } from "../src/index.js";

let seq = 0;
const call = (
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): TraceToolCall => ({
  type: "tool_call",
  seq: ++seq,
  tool,
  args,
  result,
  isError: false,
  startedAt: "2026-10-01T07:00:00.000Z",
  durationMs: 5,
});

const tools = ["list_items", "get_item", "archive_item"].map((name) => ({
  name,
  inputSchema: {},
  annotations: { readOnlyHint: name !== "archive_item" },
}));

/** One recording: a list, then get_item for each item (becomes a loop). */
function recording(etas: Array<string | null>): TraceFile {
  const ids = etas.map((_, i) => `it-${i}${etas.length}`);
  const calls = [
    call(
      "list_items",
      { date: "2026-10-01" },
      { items: ids.map((id) => ({ id })) },
    ),
    ...ids.map((id, i) =>
      call("get_item", { id }, { id, eta: etas[i], body: `body of ${id}` }),
    ),
  ];
  return {
    meta: {
      type: "meta",
      version: 1,
      task: "guards",
      startedAt: "2026-10-01T07:00:00.000Z",
      server: "demo",
      inputs: { date: "2026-10-01" },
      tools,
    },
    calls,
    end: {
      type: "end",
      endedAt: "2026-10-01T07:00:05.000Z",
      toolCalls: calls.length,
    },
  };
}

const etaOf = (w: Workflow): unknown => {
  const loop = w.steps.find((s) => s.type === "foreach");
  if (loop?.type !== "foreach") throw new Error("no loop");
  const schema = loop.body[0]!.guard.schema as {
    properties: Record<string, unknown>;
  };
  return schema.properties.eta;
};

describe("the guard of a loop body", () => {
  it("allows a null and a string when the items had both", () => {
    const w = workflowSchema.parse(
      compileTraces(
        [recording([null, "2026-11-22", null]), recording([null, null])],
        "t",
      ).workflow,
    );
    expect(etaOf(w)).toEqual({ type: ["string", "null"] });
  });

  it("allows both when two recordings differ, whichever is newer", () => {
    const a = recording([null, null, null]);
    const b = recording(["2026-11-22", "2026-11-23"]);
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const w = workflowSchema.parse(compileTraces(order, "t").workflow);
      expect(etaOf(w)).toEqual({ type: ["string", "null"] });
    }
  });

  it("still pins the type when every item agrees", () => {
    const w = workflowSchema.parse(
      compileTraces(
        [recording(["2026-11-22"]), recording(["2026-11-23", "2026-11-24"])],
        "t",
      ).workflow,
    );
    expect(etaOf(w)).toEqual({ type: "string" });
  });
});

describe("inferCommonSchema with null", () => {
  it("makes a sometimes-null scalar accept both, and leaves other mixes open", () => {
    expect(inferCommonSchema(["a", null])).toEqual({
      type: ["string", "null"],
    });
    expect(inferCommonSchema([1, null, 2])).toEqual({
      type: ["number", "null"],
    });
    expect(inferCommonSchema([1, "x"])).toEqual({});
    expect(inferCommonSchema([{}, null])).toEqual({});
  });
});
