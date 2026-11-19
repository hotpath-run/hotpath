import { describe, expect, it } from "vitest";

import {
  stripThinking,
  toolCallsFromText,
  unwrapAnswer,
} from "../src/model-output.js";

const tools = ["get_weather", "send_message"];

describe("toolCallsFromText", () => {
  it("reads a bare JSON object (qwen2.5-coder style)", () => {
    const text =
      '{"name": "get_weather", "arguments": {"city": "Paris", "date": "2026-10-01"}}';
    const { calls, rest } = toolCallsFromText(text, tools);
    expect(calls).toEqual([
      {
        id: "text_call_0",
        name: "get_weather",
        arguments: { city: "Paris", date: "2026-10-01" },
      },
    ]);
    expect(rest).toBe("");
  });

  it("reads Qwen/Hermes <tool_call> tags, several in one reply", () => {
    const text =
      "Sure.\n<tool_call>\n" +
      '{"name": "get_weather", "arguments": {"city": "Paris"}}\n</tool_call>\n' +
      '<tool_call>{"name": "send_message", "arguments": {"to": "me", "text": "hi"}}</tool_call>';
    const { calls, rest } = toolCallsFromText(text, tools);
    expect(calls.map((c) => c.name)).toEqual(["get_weather", "send_message"]);
    expect(calls[1].arguments).toEqual({ to: "me", text: "hi" });
    expect(rest).toBe("Sure.");
  });

  it("reads a fenced ```json block and an array of calls", () => {
    const text =
      "```json\n[" +
      '{"name": "get_weather", "arguments": {"city": "Paris"}},' +
      '{"name": "send_message", "parameters": {"to": "me"}}' +
      "]\n```";
    const { calls } = toolCallsFromText(text, tools);
    expect(calls.map((c) => [c.name, c.arguments])).toEqual([
      ["get_weather", { city: "Paris" }],
      ["send_message", { to: "me" }],
    ]);
  });

  it("reads several JSON objects in a row (qwen2.5-coder plans every call at once)", () => {
    const text =
      '{"name": "get_weather", "arguments": {}}\n' +
      '{"name": "send_message", "arguments": {"text": "Emails: [Subject1]\\n}", "to": "me"}}';
    const { calls, rest } = toolCallsFromText(text, tools);
    expect(calls.map((c) => c.name)).toEqual(["get_weather", "send_message"]);
    // braces inside strings do not confuse the splitter
    expect(calls[1].arguments.text).toBe("Emails: [Subject1]\n}");
    expect(rest).toBe("");
  });

  it("reads pretty-printed objects in a row", () => {
    const text =
      '{\n  "name": "get_weather",\n  "arguments": {"city": "Paris"}\n}\n\n' +
      '{\n  "name": "get_weather",\n  "arguments": {"city": "Lyon"}\n}';
    expect(
      toolCallsFromText(text, tools).calls.map((c) => c.arguments.city),
    ).toEqual(["Paris", "Lyon"]);
  });

  it("does not treat prose with a JSON object inside as calls", () => {
    const text = 'Here you go: {"name": "get_weather", "arguments": {}} thanks';
    expect(toolCallsFromText(text, tools).calls).toEqual([]);
  });

  it("parses arguments given as a JSON string", () => {
    const text =
      '{"name": "get_weather", "arguments": "{\\"city\\": \\"Paris\\"}"}';
    expect(toolCallsFromText(text, tools).calls[0].arguments).toEqual({
      city: "Paris",
    });
  });

  it("ignores JSON that names no known tool, and plain prose", () => {
    expect(
      toolCallsFromText('{"name": "rm_rf", "arguments": {}}', tools).calls,
    ).toEqual([]);
    expect(
      toolCallsFromText("Good morning! You have 3 emails.", tools).calls,
    ).toEqual([]);
    expect(toolCallsFromText('{"city": "Paris"}', tools).calls).toEqual([]);
  });

  it("finds no calls when no tools were offered", () => {
    const text = '{"name": "get_weather", "arguments": {}}';
    expect(toolCallsFromText(text, []).calls).toEqual([]);
  });
});

describe("stripThinking", () => {
  it("removes <think> blocks and trims", () => {
    expect(stripThinking("<think>\nlet me see\n</think>\n\nHello")).toBe(
      "Hello",
    );
  });

  it("drops an unclosed <think> (output cut off mid-thought)", () => {
    expect(stripThinking("<think>still thinking")).toBe("");
  });

  it("leaves normal text alone", () => {
    expect(stripThinking("Hi <b>there</b>")).toBe("Hi <b>there</b>");
  });
});

describe("unwrapAnswer", () => {
  it("takes off quotes or a fence around the whole answer", () => {
    expect(unwrapAnswer('"""\nTotal: -428 EUR\n"""')).toBe("Total: -428 EUR");
    expect(unwrapAnswer("```text\nHello\nthere\n```")).toBe("Hello\nthere");
  });
  it("leaves an answer alone when the wrapper is not around all of it", () => {
    const text = 'He said """hi""" today';
    expect(unwrapAnswer(text)).toBe(text);
    expect(unwrapAnswer("Report\n```\ncode\n```")).toBe(
      "Report\n```\ncode\n```",
    );
  });
});
