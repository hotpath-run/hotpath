import { beforeEach, describe, expect, it, vi } from "vitest";

// Never talks to a real API: a fake client with a spy is injected.
import OpenAI from "openai";
import {
  chat,
  cheapMaxTokens,
  cheapReasoning,
  DEFAULT_CHEAP_MAX_TOKENS,
  listModels,
  MAX_RETRY_WAIT_MS,
  parseMaxTokens,
  parseReasoningEffort,
  retryDelayMs,
  setClientForTesting,
} from "../src/llm.js";

const create = vi.fn();

const apiError = (status: number) =>
  new OpenAI.APIError(status, { message: "bad" }, "bad", {});

const rateLimit = (headers: Record<string, string>) =>
  new OpenAI.APIError(429, { message: "slow down" }, "slow down", headers);

const reply = {
  choices: [{ message: { content: "hi", tool_calls: [] } }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
};

beforeEach(() => {
  setClientForTesting({
    chat: { completions: { create } },
  } as unknown as OpenAI);
  create.mockReset();
  create.mockResolvedValue(reply);
});

describe("parseReasoningEffort", () => {
  it("defaults to none: replay steps don't need thinking (2-20x slower, docs/BENCHMARK.md)", () => {
    expect(parseReasoningEffort(undefined)).toBe("none");
    expect(parseReasoningEffort("")).toBe("none");
  });

  it("default leaves it to the provider (sends nothing)", () => {
    expect(parseReasoningEffort("default")).toBeUndefined();
    expect(parseReasoningEffort("DEFAULT")).toBeUndefined();
  });

  it("accepts low/medium/high", () => {
    expect(parseReasoningEffort("low")).toBe("low");
    expect(parseReasoningEffort("HIGH")).toBe("high");
  });

  it("accepts none (Ollama: turns thinking off, ~8x faster on qwen3)", () => {
    expect(parseReasoningEffort("none")).toBe("none");
  });

  it("rejects anything else with a message saying what to do", () => {
    expect(() => parseReasoningEffort("fast")).toThrow(
      /HOTPATH_CHEAP_REASONING.*none, low, medium, high or default/,
    );
  });
});

describe("cheapReasoning", () => {
  it("reads HOTPATH_CHEAP_REASONING at call time", () => {
    process.env.HOTPATH_CHEAP_REASONING = "low";
    expect(cheapReasoning()).toBe("low");
    delete process.env.HOTPATH_CHEAP_REASONING;
    expect(cheapReasoning()).toBe("none");
  });
});

describe("chat reasoningEffort", () => {
  const messages = [{ role: "user" as const, content: "x" }];

  it("passes reasoning_effort when asked", async () => {
    await chat({ model: "m", messages, reasoningEffort: "low" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].reasoning_effort).toBe("low");
  });

  it("omits it by default", async () => {
    await chat({ model: "m", messages });
    expect("reasoning_effort" in create.mock.calls[0][0]).toBe(false);
  });

  it("retries once without it when the provider rejects the parameter", async () => {
    create.mockRejectedValueOnce(apiError(400));
    const result = await chat({ model: "m", messages, reasoningEffort: "low" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].reasoning_effort).toBe("low");
    expect("reasoning_effort" in create.mock.calls[1][0]).toBe(false);
    expect(result.text).toBe("hi");
  });

  it("remembers a model that rejected it: no failed round trip on every call", async () => {
    create.mockRejectedValueOnce(apiError(400));
    await chat({ model: "m", messages, reasoningEffort: "none" });
    await chat({ model: "m", messages, reasoningEffort: "none" });
    expect(create).toHaveBeenCalledTimes(3); // reject, retry, then straight in
    expect("reasoning_effort" in create.mock.calls[2][0]).toBe(false);
    // another model still gets it
    await chat({ model: "other", messages, reasoningEffort: "none" });
    expect(create.mock.calls[3][0].reasoning_effort).toBe("none");
  });

  it("does not swallow other errors", async () => {
    create.mockRejectedValueOnce(apiError(401));
    await expect(
      chat({ model: "m", messages, reasoningEffort: "low" }),
    ).rejects.toThrow(/401/);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("parseMaxTokens / cheapMaxTokens", () => {
  it("defaults to a cap, 0 means none, a number is used as given", () => {
    expect(parseMaxTokens(undefined)).toBe(DEFAULT_CHEAP_MAX_TOKENS);
    expect(parseMaxTokens(" ")).toBe(DEFAULT_CHEAP_MAX_TOKENS);
    expect(parseMaxTokens("0")).toBeUndefined();
    expect(parseMaxTokens("4000")).toBe(4000);
  });

  it("rejects anything else with a message saying what to do", () => {
    expect(() => parseMaxTokens("lots")).toThrow(
      /HOTPATH_CHEAP_MAX_TOKENS.*whole number.*0 for no cap/,
    );
    expect(() => parseMaxTokens("-5")).toThrow(/HOTPATH_CHEAP_MAX_TOKENS/);
  });

  it("reads HOTPATH_CHEAP_MAX_TOKENS at call time", () => {
    process.env.HOTPATH_CHEAP_MAX_TOKENS = "123";
    expect(cheapMaxTokens()).toBe(123);
    delete process.env.HOTPATH_CHEAP_MAX_TOKENS;
    expect(cheapMaxTokens()).toBe(DEFAULT_CHEAP_MAX_TOKENS);
  });
});

describe("chat maxTokens", () => {
  const messages = [{ role: "user" as const, content: "x" }];

  it("sends max_tokens only when asked", async () => {
    await chat({ model: "m", messages, maxTokens: 50 });
    expect(create.mock.calls[0][0].max_tokens).toBe(50);
    await chat({ model: "m", messages });
    expect("max_tokens" in create.mock.calls[1][0]).toBe(false);
  });

  it("reports an answer cut off at the cap", async () => {
    create.mockResolvedValueOnce({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      usage: { prompt_tokens: 3, completion_tokens: 50 },
    });
    expect(
      (await chat({ model: "m", messages, maxTokens: 50 })).truncated,
    ).toBe(true);
    expect((await chat({ model: "m", messages })).truncated).toBe(false);
  });
});

describe("listModels (hotpath doctor)", () => {
  it("returns the ids the provider lists, without spending tokens", async () => {
    async function* pages() {
      yield { id: "qwen3:1.7b" };
      yield { id: "qwen3.5:4b" };
    }
    setClientForTesting({
      chat: { completions: { create } },
      models: { list: () => pages() },
    } as unknown as OpenAI);
    expect(await listModels()).toEqual(["qwen3:1.7b", "qwen3.5:4b"]);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("retryDelayMs", () => {
  it("prefers retry-after-ms, then retry-after seconds, then backoff", () => {
    expect(retryDelayMs({ "retry-after-ms": "180" }, 0)).toBe(180);
    expect(retryDelayMs({ "retry-after": "2" }, 0)).toBe(2000);
    expect(retryDelayMs({}, 0)).toBe(500);
    expect(retryDelayMs({}, 2)).toBe(2000);
    expect(retryDelayMs(undefined, 10)).toBe(8000); // capped
  });
});

describe("rate-limit retries are counted, not hidden", () => {
  const messages = [{ role: "user" as const, content: "x" }];

  it("waits out a 429, retries, and reports the time spent waiting", async () => {
    create
      .mockRejectedValueOnce(rateLimit({ "retry-after-ms": "40" }))
      .mockRejectedValueOnce(rateLimit({ "retry-after-ms": "30" }));
    const result = await chat({ model: "m", messages });
    expect(create).toHaveBeenCalledTimes(3);
    expect(result.text).toBe("hi");
    expect(result.rateLimitWaitMs).toBeGreaterThanOrEqual(70);
    expect(result.rateLimitWaitMs).toBeLessThan(400);
  });

  it("reports 0 when nothing was rate limited", async () => {
    const result = await chat({ model: "m", messages });
    expect(result.rateLimitWaitMs).toBe(0);
  });

  it("gives up after the retry limit and throws the 429", async () => {
    create.mockRejectedValue(rateLimit({ "retry-after-ms": "1" }));
    await expect(chat({ model: "m", messages })).rejects.toThrow(/429/);
    expect(create).toHaveBeenCalledTimes(7); // 1 try + 6 retries
  });

  it("does not wait minutes for a daily quota: a long retry-after fails fast", async () => {
    create.mockRejectedValue(rateLimit({ "retry-after": "225" }));
    const started = Date.now();
    await expect(chat({ model: "m", messages })).rejects.toThrow(/429/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("retry wait policy", () => {
  it("is long enough to wait out a per-minute rate-limit window", () => {
    // Groq answered "try again in 31s" for a per-minute token limit
    expect(MAX_RETRY_WAIT_MS).toBeGreaterThanOrEqual(61_000);
    expect(MAX_RETRY_WAIT_MS).toBeLessThan(120_000); // a 2-minute+ ask is a quota
  });
});

describe("chat with small open models", () => {
  const messages = [{ role: "user" as const, content: "brief please" }];
  const tools = [
    {
      name: "send_message",
      description: "send",
      parameters: { type: "object" },
    },
  ];
  const textReply = (content: string) => ({
    choices: [{ message: { content, tool_calls: [] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });

  it("recovers a tool call the model wrote as text (qwen2.5-coder)", async () => {
    create.mockResolvedValue(
      textReply(
        '{"name": "send_message", "arguments": {"to": "me", "text": "hi"}}',
      ),
    );
    const result = await chat({ model: "m", messages, tools });
    expect(result.toolCalls).toEqual([
      {
        id: "text_call_0",
        name: "send_message",
        arguments: { to: "me", text: "hi" },
      },
    ]);
    expect(result.text).toBeNull();
  });

  it("strips leaked <think> blocks from the text", async () => {
    create.mockResolvedValue(textReply("<think>hmm</think>\nGood morning"));
    const result = await chat({ model: "m", messages });
    expect(result.text).toBe("Good morning");
  });

  it("leaves plain replies alone when tools were offered", async () => {
    create.mockResolvedValue(textReply("All done."));
    const result = await chat({ model: "m", messages, tools });
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe("All done.");
  });
});

describe("provider data on tool calls (Gemini 3 thought_signature)", () => {
  const extra = { google: { thought_signature: "sig-1" } };

  it("keeps extra_content from a tool call and sends it back on the next turn", async () => {
    create.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                extra_content: extra,
                function: { name: "get_x", arguments: '{"date":"d"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const first = await chat({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      tools: [{ name: "get_x", description: "x", parameters: {} }],
    });
    expect(first.toolCalls[0]!.extra).toEqual(extra);

    await chat({
      model: "m",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, toolCalls: first.toolCalls },
        { role: "tool", toolCallId: "c1", name: "get_x", content: "42" },
      ],
    });
    const sent = create.mock.calls.at(-1)![0].messages[1].tool_calls[0];
    expect(sent.extra_content).toEqual(extra);
  });

  it("sends nothing extra for providers that do not use it", async () => {
    await chat({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "c", name: "t", arguments: {} }],
        },
      ],
    });
    const sent = create.mock.calls.at(-1)![0].messages[0].tool_calls[0];
    expect("extra_content" in sent).toBe(false);
  });
});
