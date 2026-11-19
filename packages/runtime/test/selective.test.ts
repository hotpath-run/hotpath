// A selective AI step (its recorded text covers only some items) is not told to
// "cover every item": the model is told to select the same way.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import { chat, type Workflow } from "@hotpathrun/shared";
import { runWorkflow, type ToolBackend } from "../src/index.js";

const chatMock = vi.mocked(chat);
beforeEach(() => {
  process.env.HOTPATH_REUSE = "0";
  chatMock.mockReset();
  chatMock.mockResolvedValue({
    text: "Unmatched: BK-2",
    toolCalls: [],
    promptTokens: 1,
    completionTokens: 1,
    llmCalls: 1,
    rateLimitWaitMs: 0,
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.HOTPATH_REUSE;
  vi.restoreAllMocks();
});

const tools: ToolBackend = {
  async call() {
    return { value: [{ ref: "BK-2" }], isError: false };
  },
};

const workflow = (selective: boolean): Workflow => ({
  version: 1,
  task: "t",
  compiledFrom: "x",
  server: "in-process",
  inputs: {},
  steps: [
    {
      id: "s1",
      type: "tool",
      tool: "lines",
      args: {},
      sideEffect: false,
      guard: {},
    },
    {
      id: "s2",
      type: "llm",
      model: "cheap",
      prompt:
        "s1 lines result:\n{{steps.s1.result}}\n\nwrite the `text`. Use only the data above and cover every item in it.",
      example: "Unmatched: BK-9",
      ...(selective ? { selective: true } : {}),
      guard: { nonEmpty: true },
    },
  ],
});

const sentPrompt = () =>
  chatMock.mock.calls[0]![0].messages[0]!.content as string;

describe("selective AI step", () => {
  it("replaces 'cover every item' with a note about selecting and figures", async () => {
    await runWorkflow(workflow(true), { inputs: {}, tools, dryRun: true });
    expect(sentPrompt()).not.toContain("cover every item");
    expect(sentPrompt()).toContain("only the items that matter");
  });

  it("an ordinary step keeps the prompt as compiled", async () => {
    await runWorkflow(workflow(false), { inputs: {}, tools, dryRun: true });
    expect(sentPrompt()).toContain("cover every item in it");
  });
});

describe("a step with model: strong", () => {
  it("is written by the agent model and costed at its price", async () => {
    process.env.PRICE_AGENT_IN = "2";
    process.env.PRICE_AGENT_OUT = "10";
    process.env.PRICE_CHEAP_IN = "0.1";
    process.env.PRICE_CHEAP_OUT = "0.5";
    chatMock.mockResolvedValue({
      text: "Unmatched: BK-2",
      toolCalls: [],
      promptTokens: 1_000_000,
      completionTokens: 0,
      llmCalls: 1,
      rateLimitWaitMs: 0,
    });
    const strong = workflow(false);
    (strong.steps[1] as { model: string }).model = "strong";
    const m = await runWorkflow(strong, { inputs: {}, tools, dryRun: true });
    const { AGENT_MODEL } = await import("@hotpathrun/shared");
    expect(chatMock.mock.calls[0]![0].model).toBe(AGENT_MODEL);
    expect(m.costUsd).toBeCloseTo(2, 5); // 1M prompt tokens at the agent's $2

    const cheap = await runWorkflow(workflow(false), {
      inputs: {},
      tools,
      dryRun: true,
    });
    expect(cheap.costUsd).toBeCloseTo(0.1, 5);
    for (const k of [
      "PRICE_AGENT_IN",
      "PRICE_AGENT_OUT",
      "PRICE_CHEAP_IN",
      "PRICE_CHEAP_OUT",
    ]) {
      delete process.env[k];
    }
  });
});

describe("calculated-figure lines on the retry", () => {
  it("the retry prompt keeps them (the retry's text is the one that is sent)", async () => {
    const w = workflow(false);
    const llm = w.steps[1] as {
      derived?: string[];
      guard: { grounding?: unknown[] };
    };
    llm.derived = ["Total unmatched: <calculated> EUR."];
    llm.guard.grounding = [{ value: "BK-2", paths: ["steps.s1.result.*.ref"] }];
    chatMock
      .mockResolvedValueOnce({
        text: "nothing useful",
        toolCalls: [],
        promptTokens: 1,
        completionTokens: 1,
        llmCalls: 1,
        rateLimitWaitMs: 0,
      })
      .mockResolvedValueOnce({
        text: "BK-2 total 5",
        toolCalls: [],
        promptTokens: 1,
        completionTokens: 1,
        llmCalls: 1,
        rateLimitWaitMs: 0,
      });
    await runWorkflow(w, { inputs: {}, tools, dryRun: true });
    expect(chatMock).toHaveBeenCalledTimes(2);
    for (const call of chatMock.mock.calls) {
      expect(call[0].messages[0]!.content as string).toContain(
        "Total unmatched: <calculated> EUR.",
      );
    }
  });
});

describe("grounding with positions", () => {
  const emails = [
    { from: "a@x.org", subject: "Launch checklist" },
    { from: "b@x.org", subject: "Invoice 2041" },
    { from: "c@x.org", subject: "Book club" },
  ];
  const run = async (answer: string, positions: number[]) => {
    const w = workflow(false);
    (w.steps[0] as { tool: string }).tool = "emails";
    const llm = w.steps[1] as {
      prompt: string;
      guard: { grounding?: unknown[] };
    };
    llm.guard.grounding = [
      {
        value: "x",
        paths: ["steps.s1.result.*.subject", "steps.s1.result.*.from"],
        positions,
      },
    ];
    chatMock.mockReset();
    chatMock.mockResolvedValue({
      text: answer,
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
      llmCalls: 1,
      rateLimitWaitMs: 0,
    });
    const t: ToolBackend = {
      async call() {
        return { value: emails, isError: false };
      },
    };
    return runWorkflow(w, {
      inputs: {},
      tools: t,
      dryRun: true,
      noFallback: true,
    });
  };

  it("passes when enough different items are mentioned, by any field", async () => {
    await expect(
      run("Launch checklist (Alice) and mail from b@x.org", [0, 1]),
    ).resolves.toBeDefined();
  });

  it("is a drift when fewer items are mentioned than the recording mentioned", async () => {
    await expect(run("Only the Launch checklist.", [0, 1])).rejects.toThrow(
      /does not mention/,
    );
  });

  it("two mentions of the same item count once", async () => {
    await expect(run("Launch checklist from a@x.org", [0, 1])).rejects.toThrow(
      /does not mention/,
    );
  });
});

describe("the retry repairs the previous answer", () => {
  it("gives the model its own text back when it only left something out", async () => {
    const w = workflow(false);
    (w.steps[1] as { guard: { grounding?: unknown[] } }).guard.grounding = [
      { value: "BK-2", paths: ["steps.s1.result.0.ref"] },
    ];
    chatMock
      .mockResolvedValueOnce({
        text: "Good report without the reference",
        toolCalls: [],
        promptTokens: 1,
        completionTokens: 1,
        llmCalls: 1,
        rateLimitWaitMs: 0,
      })
      .mockResolvedValueOnce({
        text: "Good report with BK-2",
        toolCalls: [],
        promptTokens: 1,
        completionTokens: 1,
        llmCalls: 1,
        rateLimitWaitMs: 0,
      });
    await runWorkflow(w, { inputs: {}, tools, dryRun: true });
    const retry = chatMock.mock.calls[1]![0].messages[0]!.content as string;
    expect(retry).toContain("Your previous answer:");
    expect(retry).toContain("Good report without the reference");
    expect(retry).toContain("- BK-2");
  });

  it("a text that is still wrong after the repair is a drift, as before", async () => {
    const w = workflow(false);
    (w.steps[1] as { guard: { grounding?: unknown[] } }).guard.grounding = [
      { value: "BK-2", paths: ["steps.s1.result.0.ref"] },
    ];
    chatMock.mockResolvedValue({
      text: "Never mentions the reference",
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
      llmCalls: 1,
      rateLimitWaitMs: 0,
    });
    await expect(
      runWorkflow(w, { inputs: {}, tools, dryRun: true, noFallback: true }),
    ).rejects.toThrow(/does not mention: BK-2/);
    expect(chatMock).toHaveBeenCalledTimes(2);
  });
});
