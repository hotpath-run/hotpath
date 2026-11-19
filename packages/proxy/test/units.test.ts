import { describe, expect, it } from "vitest";

import {
  fromAnthropicRequest,
  fromOpenAiRequest,
  inferInputs,
  matchTemplate,
  redact,
  replyFromJson,
  replyFromStream,
  replyToJson,
  replyToStream,
  routeOf,
  templateOf,
  type ApiFormat,
  type Reply,
} from "../src/index.js";

const reply: Reply = {
  text: "Reading the orders.",
  toolCalls: [
    { id: "call_1", name: "get_orders", args: { date: "2026-10-01" } },
    { id: "call_2", name: "get_stock", args: { sku: "B-7", deep: { a: 1 } } },
  ],
  stop: "tool",
  model: "m",
};

describe.each<ApiFormat>(["openai", "anthropic"])("%s replies", (format) => {
  it("survive a round trip as JSON and as a stream", () => {
    expect(replyFromJson(format, replyToJson(format, reply))).toEqual(reply);
    expect(replyFromStream(format, replyToStream(format, reply, true))).toEqual(
      reply,
    );
    const text: Reply = { ...reply, toolCalls: [], stop: "stop" };
    expect(replyFromStream(format, replyToStream(format, text))).toEqual(text);
  });
});

describe("requests", () => {
  it("read tool calls and results from Chat Completions", () => {
    const c = fromOpenAiRequest({
      model: "m",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "Report for X" }] },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "t", arguments: '{"a":1}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
      ],
      tools: [{ type: "function", function: { name: "t", parameters: {} } }],
    });
    expect(c).toMatchObject({
      stream: true,
      includeUsage: true,
      system: "Be brief.",
      tools: [{ name: "t" }],
      messages: [
        { role: "user", text: "Report for X" },
        {
          role: "assistant",
          toolCalls: [{ id: "c1", name: "t", args: { a: 1 } }],
        },
        { role: "tool", callId: "c1", content: '{"ok":true}', isError: false },
      ],
    });
  });

  it("read tool use and errored results from Messages", () => {
    const c = fromAnthropicRequest({
      model: "m",
      system: [{ type: "text", text: "Be brief." }],
      messages: [
        { role: "user", content: "Report for X" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "u1", name: "t", input: { a: 1 } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "u1",
              content: [{ type: "text", text: "boom" }],
              is_error: true,
            },
          ],
        },
      ],
    });
    expect(c.system).toBe("Be brief.");
    expect(c.messages).toEqual([
      { role: "user", text: "Report for X" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "u1", name: "t", args: { a: 1 } }],
      },
      { role: "tool", callId: "u1", content: "boom", isError: true },
    ]);
  });
});

describe("inputs", () => {
  it("are argument values taken from what the agent was asked", () => {
    const prompt = "Send the report for 2026-10-01 to team 7.";
    const inputs = inferInputs(
      [
        { args: { date: "2026-10-01", limit: 50 } },
        // an id the model read from a result is not an input
        { args: { order: "A-1001", team: 7 } },
      ],
      prompt,
    );
    expect(inputs).toEqual({ date: "2026-10-01" });
    const template = templateOf(prompt, inputs);
    expect(template).toBe("Send the report for {{inputs.date}} to team 7.");
    expect(
      matchTemplate(template, "Send the report for 2026-11-30 to team 7."),
    ).toEqual({ date: "2026-11-30" });
    expect(matchTemplate(template, "Something else entirely.")).toBeNull();
  });

  it("come from the user message, and from the system prompt only without one there", () => {
    const calls = [{ args: { date: "2026-10-01", to: "ops" } }];
    const system = 'Call send_report with to="ops". Today is 2026-10-01.';
    expect(inferInputs(calls, "Report for 2026-10-01.", system)).toEqual({
      date: "2026-10-01",
    });
    expect(inferInputs(calls, "Send the report.", system)).toEqual({
      date: "2026-10-01",
      to: "ops",
    });
  });

  it("do not match inside a longer number", () => {
    expect(inferInputs([{ args: { n: "10" } }], "on 2026-10-01")).toEqual({});
  });
});

describe("routes and secrets", () => {
  it("map SDK paths to the upstream", () => {
    expect(routeOf("/v1/chat/completions")).toEqual({
      format: "openai",
      chat: true,
      rest: "/chat/completions",
    });
    expect(routeOf("/v1/models").rest).toBe("/models");
    expect(routeOf("/v1/messages")).toEqual({
      format: "anthropic",
      chat: true,
      rest: "/v1/messages",
    });
    expect(routeOf("/v1/messages/count_tokens").chat).toBe(false);
  });

  it("are redacted from anything the proxy writes", () => {
    expect(
      redact("bad key Bearer sk-abc123 here", [
        "Bearer sk-abc123",
        "sk-abc123",
      ]),
    ).toBe("bad key [key] here");
  });
});
