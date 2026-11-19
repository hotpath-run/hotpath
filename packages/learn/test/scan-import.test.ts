import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ImportError,
  detectFormat,
  importJson,
  importLangSmith,
  importLangfuse,
  importOtlp,
} from "../src/index.js";

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "scan",
);
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(dir, name), "utf8"));

describe("importOtlp", () => {
  const runs = importOtlp(fixture("otlp.json"));
  const ok = runs.find((r) => r.id.startsWith("5b8e"))!;
  const bad = runs.find((r) => r.id.startsWith("9c1d"))!;

  it("makes one run per trace id with its tool calls in time order", () => {
    expect(runs).toHaveLength(2);
    expect(ok.trace.calls.map((c) => c.tool)).toEqual([
      "lookup_customer",
      "get_invoices",
    ]);
    expect(ok.trace.calls[1]!.args).toEqual({ customer_id: "c_42", limit: 5 });
    expect(ok.trace.calls[0]!.result).toEqual({
      customer_id: "c_42",
      plan: "pro",
    });
    expect(ok.trace.open).toBeUndefined();
  });

  it("sums token usage over the model calls and keeps the model", () => {
    expect(ok.usage).toEqual({
      inputTokens: 2700,
      outputTokens: 145,
      models: ["gpt-4.1-2025-04-14", "gpt-4.1"],
    });
    expect(bad.usage).toBeNull();
  });

  it("marks a failed tool span as an error", () => {
    expect(bad.trace.calls[0]!.isError).toBe(true);
  });

  it("refuses a file that is not OTLP", () => {
    expect(() => importOtlp({ spans: [] })).toThrow(ImportError);
  });
});

describe("importLangSmith", () => {
  const [run] = importLangSmith(fixture("langsmith.json"));

  it("takes tool runs as calls and unwraps LangChain's input text", () => {
    expect(run!.trace.calls.map((c) => c.tool)).toEqual([
      "find_order",
      "issue_refund",
    ]);
    expect(run!.trace.calls[0]!.args).toEqual({ order_id: 1138 });
    expect(run!.trace.calls[0]!.result).toEqual({ status: "paid" });
  });

  it("flags a tool run with an error, and reads tokens, cost and model", () => {
    expect(run!.trace.calls.map((c) => c.isError)).toEqual([false, true]);
    expect(run!.usage).toEqual({
      inputTokens: 2000,
      outputTokens: 150,
      costUsd: 0.0075,
      models: ["claude-sonnet-5-5"],
    });
  });

  it("accepts a {runs: [...]} wrapper and refuses anything else", () => {
    expect(importLangSmith({ runs: fixture("langsmith.json") })).toHaveLength(
      1,
    );
    expect(() => importLangSmith({ nope: 1 })).toThrow(ImportError);
  });
});

describe("importLangfuse", () => {
  const [run] = importLangfuse(fixture("langfuse.json"));

  it("takes TOOL observations as calls, with object or text input", () => {
    expect(run!.trace.calls.map((c) => c.tool)).toEqual([
      "get_emails",
      "send_message",
    ]);
    expect(run!.trace.calls[0]!.args).toEqual({
      folder: "inbox",
      unread: true,
    });
    expect(run!.trace.calls[1]!.args).toEqual({ to: "team", body: "digest" });
    expect(run!.trace.calls.map((c) => c.isError)).toEqual([false, true]);
  });

  it("reads usage and cost from GENERATION observations", () => {
    expect(run!.usage).toEqual({
      inputTokens: 900,
      outputTokens: 40,
      costUsd: 0.000159,
      models: ["gpt-4o-mini"],
    });
  });

  it("also reads a flat list of observations, grouped by traceId", () => {
    const obs = (id: string, traceId: string, name: string) => ({
      id,
      traceId,
      type: "TOOL",
      name,
      startTime: "2026-11-18T08:00:00Z",
      endTime: "2026-11-18T08:00:01Z",
    });
    const runs = importLangfuse({
      data: [obs("a", "x", "t1"), obs("b", "y", "t2")],
    });
    expect(runs.map((r) => r.trace.calls[0]!.tool)).toEqual(["t1", "t2"]);
  });
});

describe("detectFormat", () => {
  it("tells the three exports apart", () => {
    expect(detectFormat(fixture("otlp.json"))).toBe("otlp");
    expect(detectFormat(fixture("langsmith.json"))).toBe("langsmith");
    expect(detectFormat(fixture("langfuse.json"))).toBe("langfuse");
    expect(detectFormat({ hello: 1 })).toBeNull();
  });

  it("importJson says what to do when the format is unknown", () => {
    expect(() => importJson({ hello: 1 }, "x.json")).toThrow(/OTLP/);
  });
});
