// A list kept oldest first (a parcel's events) gets its newest item handed to
// the replay model as a fact: a small model misread which one was latest.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// a saved answer for this data would skip the model call this test inspects
beforeAll(() => {
  process.env.HOTPATH_REUSE = "0";
});
afterAll(() => {
  delete process.env.HOTPATH_REUSE;
});

vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import { chat, type Workflow } from "@hotpathrun/shared";
import { runWorkflow, type ToolBackend } from "../src/index.js";
import { latestItemFacts, stepsRead } from "../src/checks.js";

const parcel = {
  tracking_number: "CO1",
  events: [
    { at: "2026-10-03T09:10:00Z", status: "Label created", place: "Lyon" },
    { at: "2026-10-05T14:00:00Z", status: "Out for delivery", place: "Paris" },
    { at: "2026-10-04T08:00:00Z", status: "In transit", place: "Brussels" },
  ],
};

describe("latestItemFacts", () => {
  const ctx = { inputs: {}, steps: { s1: { result: parcel } } };

  it("names the newest item by its date field, wherever it sits", () => {
    const facts = latestItemFacts(["s1"], ctx);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toContain("s1.result.events");
    expect(facts[0]).toContain("Out for delivery");
    expect(facts[0]).not.toContain("Brussels");
  });

  it("says nothing for lists without a date field, one item, or odd dates", () => {
    const plain = {
      inputs: {},
      steps: { s1: { result: { items: [{ n: 1 }, { n: 2 }] } } },
    };
    const one = {
      inputs: {},
      steps: { s1: { result: { events: [parcel.events[0]] } } },
    };
    const odd = {
      inputs: {},
      steps: { s1: { result: { events: [{ at: "soon" }, { at: "later" }] } } },
    };
    expect(latestItemFacts(["s1"], plain)).toEqual([]);
    expect(latestItemFacts(["s1"], one)).toEqual([]);
    expect(latestItemFacts(["s1"], odd)).toEqual([]);
  });

  it("only looks at the steps the prompt reads", () => {
    expect(
      stepsRead("a {{steps.s2.result}} b {{steps.s2.result.x}} {{inputs.q}}"),
    ).toEqual(["s2"]);
    expect(latestItemFacts([], ctx)).toEqual([]);
  });
});

describe("the AI step's prompt", () => {
  beforeEach(() => {
    vi.mocked(chat).mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("carries the newest event as a fact", async () => {
    vi.mocked(chat).mockResolvedValue({
      text: "Your parcel is out for delivery in Paris.",
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
      llmCalls: 1,
    });
    const workflow: Workflow = {
      version: 1,
      task: "parcel",
      compiledFrom: "test",
      server: "in-process",
      inputs: {},
      steps: [
        {
          id: "s1",
          type: "tool",
          tool: "track_parcel",
          args: {},
          sideEffect: false,
          guard: {},
        },
        {
          id: "s2",
          type: "llm",
          model: "cheap",
          prompt: "Parcel:\n{{steps.s1.result}}\nwrite the text.",
          example: "Your parcel is in transit in Lyon.",
          inputKey: "other",
          guard: { nonEmpty: true, maxChars: 500 },
        },
      ],
    };
    const tools: ToolBackend = {
      call: async () => ({ value: parcel, isError: false }),
    };
    await runWorkflow(workflow, { inputs: {}, tools, noFallback: true });
    const sent = vi.mocked(chat).mock.calls[0]![0].messages[0]!
      .content as string;
    expect(sent).toContain("The latest item of s1.result.events");
    expect(sent).toContain("Out for delivery");
  });
});

describe("an old workflow whose prompt lacks the request", () => {
  it("gets the customer's message and the language rule at run time", async () => {
    vi.mocked(chat).mockResolvedValue({
      text: "Your parcel is out for delivery in Paris.",
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
      llmCalls: 1,
    });
    const workflow: Workflow = {
      version: 1,
      task: "parcel",
      compiledFrom: "test",
      server: "in-process",
      inputs: {
        id: { type: "string", example: "A1" },
        message: { type: "string", example: "where is my parcel?" },
      },
      steps: [
        {
          id: "s1",
          type: "tool",
          tool: "track_parcel",
          args: {},
          sideEffect: false,
          guard: {},
        },
        {
          id: "s2",
          type: "llm",
          model: "cheap",
          prompt: "Parcel:\n{{steps.s1.result}}\nwrite the text.",
          example: "Su paquete está en tránsito.",
          inputKey: "other",
          guard: { nonEmpty: true, maxChars: 500 },
        },
      ],
    };
    const tools: ToolBackend = {
      call: async () => ({ value: parcel, isError: false }),
    };
    await runWorkflow(workflow, {
      inputs: { id: "A1", message: "Hi, where is my parcel now?" },
      tools,
      noFallback: true,
    });
    const sent = vi.mocked(chat).mock.calls.at(-1)![0].messages[0]!
      .content as string;
    expect(sent).toContain("Hi, where is my parcel now?");
    expect(sent).toMatch(/language of today's request, not the example's/);
    // after the example, so the example does not have the last word
    expect(sent.indexOf("Hi, where is my parcel now?")).toBeGreaterThan(
      sent.indexOf("Su paquete está en tránsito."),
    );
    expect(sent).not.toContain("A1");
  });

  it("does not reuse an answer saved for another request", async () => {
    process.env.HOTPATH_REUSE = "1";
    try {
      vi.mocked(chat).mockReset();
      vi.mocked(chat).mockResolvedValue({
        text: "Your parcel is out for delivery in Paris.",
        toolCalls: [],
        promptTokens: 1,
        completionTokens: 1,
        llmCalls: 1,
      });
      const workflow: Workflow = {
        version: 1,
        task: "parcel-reuse",
        compiledFrom: "test",
        server: "in-process",
        inputs: { message: { type: "string", example: "recorded words here" } },
        steps: [
          {
            id: "s1",
            type: "tool",
            tool: "track_parcel",
            args: {},
            sideEffect: false,
            guard: {},
          },
          {
            id: "s2",
            type: "llm",
            model: "cheap",
            prompt: "Parcel:\n{{steps.s1.result}}\nwrite the text.",
            example: "Su paquete está en tránsito.",
            inputKey: "other",
            guard: { nonEmpty: true, maxChars: 500 },
          },
        ],
      };
      const tools: ToolBackend = {
        call: async () => ({ value: parcel, isError: false }),
      };
      const stamp = String(Date.now());
      const go = (message: string) =>
        runWorkflow(workflow, { inputs: { message }, tools, noFallback: true });
      await go(`where is my parcel ${stamp}`);
      expect(chat).toHaveBeenCalledTimes(1);
      await go(`where is my parcel ${stamp}`);
      expect(chat).toHaveBeenCalledTimes(1); // same request: reused
      await go(`is my parcel late ${stamp}`);
      expect(chat).toHaveBeenCalledTimes(2); // another request: asked again
    } finally {
      process.env.HOTPATH_REUSE = "0";
    }
  });
});
