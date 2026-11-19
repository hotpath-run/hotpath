// Tool changes beyond a renamed field (task 14): a removed field, a changed
// type, a new enum value, an empty result and an error payload. Each must stop
// the run before the side effect (send_message) with a reason that says what
// changed; the fallback agent then does the run and its recording teaches the
// workflow (measured for the finance task in docs/BENCHMARK.md, step 6).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import { compileRecording } from "@hotpathrun/compiler";
import { chat, type TraceFile, type Workflow } from "@hotpathrun/shared";
import { DriftError, runWorkflow, type ToolBackend } from "../src/index.js";

const chatMock = vi.mocked(chat);

const RECORDED = [
  { id: "INV-9001", customer: "Verdier et Fils", amount: 320, currency: "USD" },
  {
    id: "INV-9002",
    customer: "Kowalczyk Studio",
    amount: 145,
    currency: "USD",
  },
  {
    id: "INV-9003",
    customer: "Ostrava Robotics",
    amount: 475,
    currency: "USD",
  },
];
const TEXT =
  "Unpaid invoices: Verdier et Fils (320 USD), Kowalczyk Studio (145 USD), " +
  "Ostrava Robotics (475 USD). Total owed: 940 USD.";
const TODAY = [
  {
    id: "INV-9010",
    customer: "Halvorsen Marine",
    amount: 210,
    currency: "USD",
  },
  {
    id: "INV-9011",
    customer: "Petit Atelier Bleu",
    amount: 385,
    currency: "USD",
  },
  { id: "INV-9012", customer: "Zielona Kawa", amount: 95, currency: "USD" },
];
const TODAY_TEXT =
  "Unpaid invoices: Halvorsen Marine (210 USD), Petit Atelier Bleu (385 USD), " +
  "Zielona Kawa (95 USD). Total owed: 690 USD.";

function recording(): TraceFile {
  const at = "2026-11-18T10:00:00.000Z";
  return {
    meta: {
      type: "meta",
      version: 1,
      task: "drift-kinds",
      startedAt: at,
      server: "in-process",
      inputs: { date: "2026-10-01" },
      tools: [
        {
          name: "list_invoices",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        { name: "send_message", inputSchema: { type: "object" } },
      ],
    },
    calls: [
      {
        type: "tool_call",
        seq: 1,
        tool: "list_invoices",
        args: { date: "2026-10-01" },
        result: RECORDED,
        isError: false,
        startedAt: at,
        durationMs: 1,
      },
      {
        type: "tool_call",
        seq: 2,
        tool: "send_message",
        args: { to: "me", text: TEXT },
        result: { ok: true, id: "m1" },
        isError: false,
        startedAt: at,
        durationMs: 1,
      },
    ],
    end: { type: "end", endedAt: at, toolCalls: 2 },
  };
}

let workflow: Workflow;
let sent: unknown[];
let reads: number;

/** The tools as they answer today: `list_invoices` gives `today` (or an MCP error). */
function tools(today: unknown, isError = false): ToolBackend {
  return {
    async call(tool, args) {
      if (tool === "send_message") {
        sent.push(args);
        return { value: { ok: true, id: "m2" }, isError: false };
      }
      reads++;
      return { value: today, isError };
    },
  };
}

async function driftOf(today: unknown, isError = false): Promise<DriftError> {
  const err = await runWorkflow(workflow, {
    inputs: { date: "2026-10-02" },
    tools: tools(today, isError),
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DriftError);
  return err as DriftError;
}

beforeEach(() => {
  process.env.HOTPATH_REUSE = "0";
  workflow = compileRecording(recording(), "test").workflow;
  sent = [];
  reads = 0;
  chatMock.mockReset();
  chatMock.mockResolvedValue({
    text: TODAY_TEXT,
    toolCalls: [],
    promptTokens: 1,
    completionTokens: 1,
    llmCalls: 1,
    rateLimitWaitMs: 0,
  } as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.HOTPATH_REUSE;
  vi.restoreAllMocks();
});

describe("tool changes stop the run before the side effect", () => {
  it("compiles the recording: total by code, currencies it saw", () => {
    const llm = workflow.steps.find((s) => s.type === "llm");
    expect(llm?.type === "llm" && llm.calculations).toEqual([
      expect.objectContaining({
        op: "sum",
        field: "amount",
        units: { field: "currency", seen: ["USD"] },
      }),
    ]);
  });

  it("healthy new data runs through and sends once (the control)", async () => {
    await runWorkflow(workflow, {
      inputs: { date: "2026-10-02" },
      tools: tools(TODAY),
    });
    expect(sent).toEqual([{ to: "me", text: TODAY_TEXT }]);
  });

  it("a removed field", async () => {
    const today = TODAY.map((i) => {
      const rest: Partial<typeof i> = { ...i };
      delete rest.amount;
      return rest;
    });
    const err = await driftOf(today);
    expect(err.stepId).toBe("s1");
    expect(err.reason).toMatch(/amount/);
    expect(err.sideEffectRan).toBe(false);
    expect(sent).toEqual([]);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("a changed type (amounts as strings)", async () => {
    const today = TODAY.map((i) => ({ ...i, amount: String(i.amount) }));
    const err = await driftOf(today);
    expect(err.stepId).toBe("s1");
    expect(err.reason).toMatch(/amount/);
    expect(sent).toEqual([]);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("a new enum value (a currency the recording never saw)", async () => {
    const today = TODAY.map((i, n) =>
      n === 1 ? { ...i, currency: "EUR" } : i,
    );
    const err = await driftOf(today);
    expect(err.stepId).toBe("s2");
    expect(err.reason).toMatch(/currency the recording never saw \(EUR\)/);
    expect(err.sideEffectRan).toBe(false);
    expect(sent).toEqual([]);
    // stopped before the model: a total mixing USD and EUR is never written
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("an empty result", async () => {
    const err = await driftOf([]);
    expect(err.stepId).toBe("s2");
    expect(err.reason).toMatch(/steps\.s1\.result is empty today/);
    expect(sent).toEqual([]);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("an error payload without isError", async () => {
    const err = await driftOf({ error: "invoice service unavailable" });
    expect(err.stepId).toBe("s1");
    expect(sent).toEqual([]);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("an error the tool flags (isError): read again once, then stop", async () => {
    const err = await driftOf({ error: "invoice service unavailable" }, true);
    expect(err.stepId).toBe("s1");
    expect(reads).toBe(2);
    expect(sent).toEqual([]);
    expect(chatMock).not.toHaveBeenCalled();
  });
});
