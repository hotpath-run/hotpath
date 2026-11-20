// Found by `pnpm fuzz`: the stale-fact guard said "Paris" was copied from the
// recorded example, although today's weather call asked for "Paris" (a constant
// argument) and so did the report. A value the run itself used is today's data.
import { describe, expect, it, vi } from "vitest";

vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import { chat, type Workflow } from "@hotpathrun/shared";
import { runWorkflow, type ToolBackend } from "../src/index.js";

process.env.HOTPATH_JOURNAL = "0";
process.env.HOTPATH_REUSE = "0";

const workflow = {
  version: 1,
  task: "args-are-data",
  compiledFrom: "test",
  server: "in-process",
  inputs: {},
  steps: [
    {
      id: "s1",
      type: "tool",
      tool: "get_weather",
      args: { city: "Paris" },
      sideEffect: false,
      guard: {},
    },
    {
      id: "s2",
      type: "llm",
      model: "cheap",
      prompt: "Weather: {{steps.s1.result}}",
      example: "Weather in Paris: rain.",
      inputKey: "never-matches",
      guard: {
        nonEmpty: true,
        // "Paris" is in the recorded result, which today's tool does not repeat
        exampleFacts: ["Paris", "rain"],
      },
    },
    {
      id: "s3",
      type: "tool",
      tool: "send_message",
      args: { text: "{{steps.s2.output}}" },
      sideEffect: true,
      guard: {},
    },
  ],
} as unknown as Workflow;

describe("values the run itself used", () => {
  it("are not stale example facts", async () => {
    vi.mocked(chat).mockResolvedValue({
      text: "Weather in Paris: sun.",
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
      llmCalls: 1,
    } as never);
    const sent: unknown[] = [];
    const tools: ToolBackend = {
      async call(tool, args) {
        if (tool === "send_message") sent.push(args);
        return { value: { summary: "sun" }, isError: false };
      },
    };
    await runWorkflow(workflow, { inputs: {}, noFallback: true, tools });
    expect(sent).toEqual([{ text: "Weather in Paris: sun." }]);
  });
});
