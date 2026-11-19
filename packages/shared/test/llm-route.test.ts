// Per-run model routes (hosted runs: testers on a free OpenAI-compatible tier, paid
// members on Anthropic). Never talks to a real API: fake clients are injected.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_MODEL,
  CHEAP_MODEL,
  chat,
  setClientForTesting,
  setRouteClientsForTesting,
  withLlmRoute,
  type LlmRoute,
} from "../src/llm.js";
import { usdCost } from "../src/pricing.js";

const prices = (inputPer1M: number, outputPer1M: number) => ({
  inputPer1M,
  outputPer1M,
});

const geminiRoute: LlmRoute = {
  provider: "openai",
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  apiKey: ["tester", "key"].join("-"),
  cheapModel: "gemini-flash-lite",
  strongModel: "gemini-flash",
  cheapPrices: prices(0, 0),
  strongPrices: prices(0, 0),
};

const claudeRoute: LlmRoute = {
  provider: "anthropic",
  apiKey: ["paid", "key"].join("-"),
  cheapModel: "claude-haiku-5-5",
  strongModel: "claude-opus-5-5",
  cheapPrices: prices(0.1, 0.5),
  strongPrices: prices(4, 20),
};

const openAiReply = {
  choices: [
    { message: { content: "routed", tool_calls: [] }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

function fakeOpenAi() {
  const create = vi.fn().mockResolvedValue(openAiReply);
  return {
    create,
    client: { chat: { completions: { create } } } as unknown as OpenAI,
  };
}

function claudeMessage(
  over: Partial<Anthropic.Message> = {},
): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: "Two meetings today.", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 30 },
    ...over,
  } as Anthropic.Message;
}

function fakeAnthropic(...replies: Array<Anthropic.Message | Error>) {
  const create = vi.fn();
  for (const r of replies) {
    if (r instanceof Error) create.mockRejectedValueOnce(r);
    else create.mockResolvedValueOnce(r);
  }
  return { create, client: { messages: { create } } as unknown as Anthropic };
}

afterEach(() => {
  setRouteClientsForTesting(null);
  setClientForTesting(null);
});

describe("withLlmRoute: OpenAI-compatible provider", () => {
  it("sends the run's calls to the route's client and model, not the default ones", async () => {
    const fallback = fakeOpenAi();
    setClientForTesting(fallback.client);
    const routed = fakeOpenAi();
    const made: LlmRoute[] = [];
    setRouteClientsForTesting({
      openai: (route) => {
        made.push(route);
        return routed.client;
      },
    });

    const result = await withLlmRoute(geminiRoute, () =>
      chat({ model: CHEAP_MODEL, messages: [{ role: "user", content: "hi" }] }),
    );

    expect(result.text).toBe("routed");
    expect(fallback.create).not.toHaveBeenCalled();
    expect(routed.create.mock.calls[0]![0].model).toBe("gemini-flash-lite");
    expect(made[0]).toMatchObject({
      baseURL: geminiRoute.baseURL,
      apiKey: ["tester", "key"].join("-"),
    });
  });

  it("maps the strong (agent) model to the route's strong model", async () => {
    const routed = fakeOpenAi();
    setRouteClientsForTesting({ openai: () => routed.client });
    await withLlmRoute(geminiRoute, () =>
      chat({ model: AGENT_MODEL, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(routed.create.mock.calls[0]![0].model).toBe("gemini-flash");
  });

  it("leaves calls outside a route on the default client", async () => {
    const fallback = fakeOpenAi();
    setClientForTesting(fallback.client);
    await chat({
      model: CHEAP_MODEL,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(fallback.create.mock.calls[0]![0].model).toBe(CHEAP_MODEL);
  });

  it("prices a routed run with the route's prices", async () => {
    await withLlmRoute(claudeRoute, async () => {
      expect(usdCost(CHEAP_MODEL, 1_000_000, 1_000_000)).toBeCloseTo(0.6);
      expect(usdCost(AGENT_MODEL, 1_000_000, 0)).toBeCloseTo(4);
    });
    await withLlmRoute(geminiRoute, async () => {
      expect(usdCost(CHEAP_MODEL, 1_000_000, 1_000_000)).toBe(0);
    });
  });
});

describe("withLlmRoute: Anthropic", () => {
  it("builds a Messages request: system apart, tools with input_schema, no sampling params", async () => {
    const fake = fakeAnthropic(claudeMessage());
    setRouteClientsForTesting({ anthropic: () => fake.client });

    await withLlmRoute(claudeRoute, () =>
      chat({
        model: CHEAP_MODEL,
        messages: [
          { role: "system", content: "Write the brief." },
          { role: "user", content: "Emails: ..." },
        ],
        tools: [
          {
            name: "send",
            description: "Send it",
            parameters: { type: "object", properties: {} },
          },
        ],
        reasoningEffort: "none",
        maxTokens: 8000,
      }),
    );

    const request = fake.create.mock.calls[0]![0];
    expect(request).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 8000,
      system: "Write the brief.",
      messages: [{ role: "user", content: "Emails: ..." }],
      tools: [
        {
          name: "send",
          description: "Send it",
          input_schema: { type: "object", properties: {} },
        },
      ],
      tool_choice: { type: "auto" },
      // "none" has no Claude equivalent: the lowest effort is the closest
      output_config: { effort: "low" },
    });
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("thinking");
  });

  it("always sends max_tokens (Claude requires it)", async () => {
    const fake = fakeAnthropic(claudeMessage());
    setRouteClientsForTesting({ anthropic: () => fake.client });
    await withLlmRoute(claudeRoute, () =>
      chat({ model: CHEAP_MODEL, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(fake.create.mock.calls[0]![0].max_tokens).toBe(16_000);
  });

  it("turns tool calls and their results into tool_use and tool_result blocks", async () => {
    const fake = fakeAnthropic(claudeMessage());
    setRouteClientsForTesting({ anthropic: () => fake.client });
    await withLlmRoute(claudeRoute, () =>
      chat({
        model: CHEAP_MODEL,
        messages: [
          { role: "user", content: "Check both" },
          {
            role: "assistant",
            content: "Looking.",
            toolCalls: [
              { id: "t1", name: "get_a", arguments: { x: 1 } },
              { id: "t2", name: "get_b", arguments: {} },
            ],
          },
          { role: "tool", toolCallId: "t1", name: "get_a", content: "A" },
          { role: "tool", toolCallId: "t2", name: "get_b", content: "B" },
        ],
      }),
    );
    expect(fake.create.mock.calls[0]![0].messages).toEqual([
      { role: "user", content: "Check both" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "t1", name: "get_a", input: { x: 1 } },
          { type: "tool_use", id: "t2", name: "get_b", input: {} },
        ],
      },
      // all results of one turn in a single user message
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "A" },
          { type: "tool_result", tool_use_id: "t2", content: "B" },
        ],
      },
    ]);
  });

  it("reads text and tool calls by block type, skipping thinking blocks", async () => {
    const fake = fakeAnthropic(
      claudeMessage({
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "Sending.", citations: null },
          {
            type: "tool_use",
            id: "t9",
            name: "send",
            input: { to: "me" },
            caller: { type: "direct" },
          },
        ] as Anthropic.ContentBlock[],
        stop_reason: "tool_use",
      }),
    );
    setRouteClientsForTesting({ anthropic: () => fake.client });
    const result = await withLlmRoute(claudeRoute, () =>
      chat({ model: CHEAP_MODEL, messages: [{ role: "user", content: "go" }] }),
    );
    expect(result).toMatchObject({
      text: "Sending.",
      toolCalls: [{ id: "t9", name: "send", arguments: { to: "me" } }],
      promptTokens: 120,
      completionTokens: 30,
      llmCalls: 1,
      truncated: false,
    });
  });

  it("reports a cut-off answer as truncated and a refusal as no answer", async () => {
    const fake = fakeAnthropic(
      claudeMessage({ stop_reason: "max_tokens" }),
      claudeMessage({ stop_reason: "refusal", content: [] }),
    );
    setRouteClientsForTesting({ anthropic: () => fake.client });
    const call = () =>
      withLlmRoute(claudeRoute, () =>
        chat({
          model: CHEAP_MODEL,
          messages: [{ role: "user", content: "go" }],
        }),
      );
    expect((await call()).truncated).toBe(true);
    // the step's guard sees no text and reports drift: no crash, no invented answer
    expect((await call()).text).toBeNull();
  });

  it("drops output_config once for a model that rejects effort, and remembers", async () => {
    const reject = new Anthropic.BadRequestError(
      400,
      { error: { message: "effort not supported" } },
      "effort not supported",
      new Headers(),
    );
    const fake = fakeAnthropic(reject, claudeMessage(), claudeMessage());
    setRouteClientsForTesting({ anthropic: () => fake.client });
    const route = { ...claudeRoute, cheapModel: "claude-haiku-4-5" };
    const call = () =>
      withLlmRoute(route, () =>
        chat({
          model: CHEAP_MODEL,
          messages: [{ role: "user", content: "go" }],
          reasoningEffort: "low",
        }),
      );
    await call();
    await call();
    const sent = fake.create.mock.calls.map((c) => c[0]);
    expect(sent[0]).toHaveProperty("output_config");
    expect(sent[1]).not.toHaveProperty("output_config");
    expect(sent[2]).not.toHaveProperty("output_config");
  });

  it("waits out a 429 and counts the wait", async () => {
    const limited = new Anthropic.RateLimitError(
      429,
      { error: { message: "slow down" } },
      "slow down",
      new Headers({ "retry-after-ms": "5" }),
    );
    const fake = fakeAnthropic(limited, claudeMessage());
    setRouteClientsForTesting({ anthropic: () => fake.client });
    const result = await withLlmRoute(claudeRoute, () =>
      chat({ model: CHEAP_MODEL, messages: [{ role: "user", content: "go" }] }),
    );
    expect(fake.create).toHaveBeenCalledTimes(2);
    expect(result.rateLimitWaitMs).toBeGreaterThanOrEqual(5);
  });
});
