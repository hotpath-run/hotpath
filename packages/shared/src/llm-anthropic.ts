// The Anthropic half of llm.ts: one chat() call as a Claude Messages API request.
// Imported only by llm.ts, which stays the single entry point for model calls.
import Anthropic from "@anthropic-ai/sdk";

import type {
  ChatMessage,
  ChatOptions,
  LlmResult,
  LlmToolCall,
  ReasoningEffort,
} from "./llm.js";
import { stripThinking } from "./model-output.js";

/** Claude requires max_tokens; thinking counts toward it, so leave room. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 16_000;

/** Models that answered output_config.effort with a 400: never send it again. */
const rejectsEffort = new Set<string>();

/**
 * Hotpath's reasoning levels as Claude effort levels. Claude has no "none" (thinking
 * is adaptive and on by default on current models); the lowest effort is closest.
 */
export function claudeEffort(
  effort: ReasoningEffort | undefined,
): "low" | "medium" | "high" | undefined {
  if (effort === undefined) return undefined;
  return effort === "none" ? "low" : effort;
}

/** Chat messages as Claude messages: system text apart, tool results as user turns. */
export function toClaudeMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  const system: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
        system.push(m.content);
        break;
      case "user":
        out.push({ role: "user", content: m.content });
        break;
      case "assistant": {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls ?? []) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        if (blocks.length) out.push({ role: "assistant", content: blocks });
        break;
      }
      case "tool": {
        const result: Anthropic.ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: m.content,
        };
        // every result of one assistant turn goes back in a single user message
        const last = out[out.length - 1];
        if (
          last?.role === "user" &&
          Array.isArray(last.content) &&
          last.content.every((b) => b.type === "tool_result")
        ) {
          last.content.push(result);
        } else {
          out.push({ role: "user", content: [result] });
        }
        break;
      }
    }
  }
  return {
    system: system.length ? system.join("\n\n") : undefined,
    messages: out,
  };
}

export async function anthropicChat(
  client: Anthropic,
  options: ChatOptions,
  retry: <T>(call: () => Promise<T>, waited: { ms: number }) => Promise<T>,
): Promise<LlmResult> {
  const { system, messages } = toClaudeMessages(options.messages);
  const effort = rejectsEffort.has(options.model)
    ? undefined
    : claudeEffort(options.reasoningEffort);
  const base: Anthropic.MessageCreateParamsNonStreaming = {
    model: options.model,
    max_tokens: options.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
    ...(system ? { system } : {}),
    ...(options.tools?.length
      ? {
          tools: options.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Tool.InputSchema,
          })),
          tool_choice: { type: "auto" as const },
        }
      : {}),
  };

  const waited = { ms: 0 };
  let response: Anthropic.Message;
  if (!effort) {
    response = await retry(() => client.messages.create(base), waited);
  } else {
    try {
      response = await retry(
        () => client.messages.create({ ...base, output_config: { effort } }),
        waited,
      );
    } catch (err) {
      // older Claude models don't take effort: ask again without it, once per model
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      rejectsEffort.add(options.model);
      response = await retry(() => client.messages.create(base), waited);
    }
  }

  // read blocks by type: a response can start with thinking blocks
  const texts: string[] = [];
  const toolCalls: LlmToolCall[] = [];
  for (const block of response.content) {
    if (block.type === "text") texts.push(block.text);
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  // a refusal has no answer: the step's guard turns that into drift
  const joined = response.stop_reason === "refusal" ? "" : texts.join("");
  return {
    text: joined ? stripThinking(joined) : null,
    toolCalls: response.stop_reason === "refusal" ? [] : toolCalls,
    promptTokens:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    completionTokens: response.usage.output_tokens,
    llmCalls: 1,
    rateLimitWaitMs: waited.ms,
    truncated: response.stop_reason === "max_tokens",
  };
}
