// Two engine gaps from the ten-task suite: a read that fails once is repeated
// once, and the length limit of a written text grows with the data.
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { countItems, scaledMaxChars, type Workflow } from "@hotpathrun/shared";

import {
  checkLlmGuard,
  DriftError,
  runWorkflow,
  type ToolBackend,
} from "../src/index.js";

// an action that errored stays "unconfirmed" in the crash journal and holds
// back the next run with the same inputs (journal.ts): every test starts clean
const journal = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.hotpath/journal/flaky",
);
beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await rm(journal, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

const guard = {};
const base = {
  version: 1 as const,
  task: "flaky",
  compiledFrom: "test",
  server: "in-process",
  inputs: {},
};

/** A tool whose first `failures` calls answer with an error. */
function flaky(failures: number) {
  const calls: string[] = [];
  const tools: ToolBackend = {
    async call(tool) {
      calls.push(tool);
      const failing = calls.filter((c) => c === tool).length <= failures;
      return failing
        ? { value: "503 try again", isError: true }
        : { value: { ok: true }, isError: false };
    },
  };
  return { tools, calls };
}

const workflow = (sideEffect: boolean): Workflow => ({
  ...base,
  steps: [
    {
      id: "s1",
      type: "tool",
      tool: sideEffect ? "send" : "get_sales",
      args: {},
      sideEffect,
      guard,
    },
  ],
});

describe("a tool step that fails once", () => {
  it("a read is repeated once and then passes", async () => {
    const b = flaky(1);
    await runWorkflow(workflow(false), { inputs: {}, tools: b.tools });
    expect(b.calls).toEqual(["get_sales", "get_sales"]);
  });

  it("a read that fails twice is still drift", async () => {
    const b = flaky(2);
    await expect(
      runWorkflow(workflow(false), { inputs: {}, tools: b.tools }),
    ).rejects.toBeInstanceOf(DriftError);
    expect(b.calls).toHaveLength(2);
  });

  it("a side effect is never repeated", async () => {
    const b = flaky(1);
    await expect(
      runWorkflow(workflow(true), { inputs: {}, tools: b.tools }),
    ).rejects.toBeInstanceOf(DriftError);
    expect(b.calls).toEqual(["send"]);
  });
});

describe("the length limit grows with the data", () => {
  it("counts list items at every level", () => {
    expect(countItems({ a: [1, 2, { b: [3] }], c: "x" })).toBe(4);
    expect(countItems("text")).toBe(0);
  });

  it("is the recorded limit on the same or less data, larger on more", () => {
    expect(scaledMaxChars(500, 4, 4)).toBe(500);
    expect(scaledMaxChars(500, 4, 2)).toBe(500);
    expect(scaledMaxChars(500, 4, 8)).toBe(1000);
    expect(scaledMaxChars(500, undefined, 8)).toBe(500);
  });

  it("a text of 550 characters passes on twice the items, not on the same", () => {
    const text = "x".repeat(550);
    const g = { nonEmpty: true, maxChars: 500, recordedItems: 4 };
    expect(checkLlmGuard(g, text, 4)).toMatch(/exceeds maxChars 500/);
    expect(checkLlmGuard(g, text, 8)).toBeNull();
  });
});

describe("a paginated read", () => {
  const paged = (maxPages?: number): Workflow => ({
    ...base,
    steps: [
      {
        id: "s1",
        type: "tool",
        tool: "list",
        args: { page: 1 },
        sideEffect: false,
        guard,
        paginate: {
          arg: "page",
          next: "next_page",
          ...(maxPages ? { maxPages } : {}),
        },
      },
    ],
  });
  const pages = (n: number): ToolBackend => ({
    async call(_tool, args) {
      const page = args.page as number;
      return {
        value: { items: [page], next_page: page < n ? page + 1 : null },
        isError: false,
      };
    },
  });

  it("asks again until there is no next page, however many there are", async () => {
    for (const n of [1, 3, 7]) {
      const m = await runWorkflow(paged(), { inputs: {}, tools: pages(n) });
      expect(m.toolCalls).toHaveLength(n);
    }
  });

  it("stops at maxPages and says so", async () => {
    await expect(
      runWorkflow(paged(3), { inputs: {}, tools: pages(10), noFallback: true }),
    ).rejects.toThrow(/more than 3 pages/);
  });
});
