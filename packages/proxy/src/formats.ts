// The two wire formats the proxy speaks (OpenAI Chat Completions and Anthropic
// Messages), reduced to one shape: what the agent asked, and what the model
// answered. Recording and replay work on this shape only, so they behave the
// same whichever SDK the agent uses.

export type ApiFormat = "openai" | "anthropic";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; callId: string; content: string; isError: boolean };

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface Conversation {
  format: ApiFormat;
  model: string;
  stream: boolean;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  /** OpenAI: stream_options.include_usage */
  includeUsage: boolean;
}

export interface Reply {
  text: string;
  toolCalls: ToolCall[];
  /** "tool": the model asked for tools; "stop": it answered */
  stop: "tool" | "stop" | "length";
  model: string;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Text of an OpenAI or Anthropic content field (a string or a list of parts). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isObject(part) && typeof part.text === "string" ? part.text : "",
    )
    .filter((t) => t.length > 0)
    .join("\n");
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (isObject(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

/** A Chat Completions request body as a conversation. */
export function fromOpenAiRequest(body: Json): Conversation {
  if (!Array.isArray(body.messages)) {
    throw new FormatError(
      "expected a Chat Completions request with a messages list",
    );
  }
  const system: string[] = [];
  const messages: Message[] = [];
  for (const m of body.messages) {
    if (!isObject(m)) continue;
    switch (m.role) {
      case "system":
      case "developer":
        system.push(textOf(m.content));
        break;
      case "user":
        messages.push({ role: "user", text: textOf(m.content) });
        break;
      case "assistant": {
        const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
        messages.push({
          role: "assistant",
          text: textOf(m.content),
          toolCalls: calls.filter(isObject).map((c) => {
            const fn = isObject(c.function) ? c.function : {};
            return {
              id: String(c.id ?? ""),
              name: String(fn.name ?? ""),
              args: parseArgs(fn.arguments),
            };
          }),
        });
        break;
      }
      case "tool":
        messages.push({
          role: "tool",
          callId: String(m.tool_call_id ?? ""),
          content: textOf(m.content),
          // Chat Completions has no error flag on a tool result
          isError: false,
        });
        break;
    }
  }
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter(isObject)
    .map((t) => (isObject(t.function) ? t.function : {}))
    .filter((fn) => typeof fn.name === "string")
    .map((fn) => ({
      name: fn.name as string,
      ...(typeof fn.description === "string"
        ? { description: fn.description }
        : {}),
      inputSchema: isObject(fn.parameters) ? fn.parameters : { type: "object" },
    }));
  const options = isObject(body.stream_options) ? body.stream_options : {};
  return {
    format: "openai",
    model: String(body.model ?? ""),
    stream: body.stream === true,
    system: system.join("\n\n"),
    messages,
    tools,
    includeUsage: options.include_usage === true,
  };
}

/** A Messages API request body as a conversation. */
export function fromAnthropicRequest(body: Json): Conversation {
  if (!Array.isArray(body.messages)) {
    throw new FormatError(
      "expected a Messages API request with a messages list",
    );
  }
  const messages: Message[] = [];
  for (const m of body.messages) {
    if (!isObject(m)) continue;
    const blocks = Array.isArray(m.content)
      ? m.content.filter(isObject)
      : [{ type: "text", text: textOf(m.content) }];
    if (m.role === "assistant") {
      messages.push({
        role: "assistant",
        text: textOf(blocks.filter((b) => b.type === "text")),
        toolCalls: blocks
          .filter((b) => b.type === "tool_use")
          .map((b) => ({
            id: String(b.id ?? ""),
            name: String(b.name ?? ""),
            args: parseArgs(b.input),
          })),
      });
      continue;
    }
    // a user turn: tool results first (the API requires them first), then text
    for (const b of blocks.filter((b) => b.type === "tool_result")) {
      messages.push({
        role: "tool",
        callId: String(b.tool_use_id ?? ""),
        content: textOf(b.content),
        isError: b.is_error === true,
      });
    }
    const text = textOf(blocks.filter((b) => b.type === "text"));
    if (text.length > 0) messages.push({ role: "user", text });
  }
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter(isObject)
    .filter((t) => typeof t.name === "string" && isObject(t.input_schema))
    .map((t) => ({
      name: t.name as string,
      ...(typeof t.description === "string"
        ? { description: t.description }
        : {}),
      inputSchema: t.input_schema as Json,
    }));
  return {
    format: "anthropic",
    model: String(body.model ?? ""),
    stream: body.stream === true,
    system: textOf(body.system),
    messages,
    tools,
    includeUsage: false,
  };
}

// ---------------------------------------------------------------- replies

const stopOf = (tools: boolean, cut: boolean): Reply["stop"] =>
  tools ? "tool" : cut ? "length" : "stop";

/** A non-streamed upstream answer as a reply. */
export function replyFromJson(format: ApiFormat, body: unknown): Reply {
  if (!isObject(body)) {
    return { text: "", toolCalls: [], stop: "stop", model: "" };
  }
  if (format === "openai") {
    const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
    const message =
      isObject(choice) && isObject(choice.message) ? choice.message : {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls = calls.filter(isObject).map((c) => {
      const fn = isObject(c.function) ? c.function : {};
      return {
        id: String(c.id ?? ""),
        name: String(fn.name ?? ""),
        args: parseArgs(fn.arguments),
      };
    });
    const finish = isObject(choice) ? choice.finish_reason : undefined;
    return {
      text: textOf(message.content),
      toolCalls,
      stop: stopOf(toolCalls.length > 0, finish === "length"),
      model: String(body.model ?? ""),
    };
  }
  const blocks = Array.isArray(body.content)
    ? body.content.filter(isObject)
    : [];
  const toolCalls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: String(b.id ?? ""),
      name: String(b.name ?? ""),
      args: parseArgs(b.input),
    }));
  return {
    text: textOf(blocks.filter((b) => b.type === "text")),
    toolCalls,
    stop: stopOf(toolCalls.length > 0, body.stop_reason === "max_tokens"),
    model: String(body.model ?? ""),
  };
}

/** The `data:` payloads of a server-sent event stream. */
function sseData(raw: string): Json[] {
  const out: Json[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (isObject(parsed)) out.push(parsed);
    } catch {
      // a line the provider split oddly: the reply is rebuilt from the rest
    }
  }
  return out;
}

/** A streamed upstream answer (the whole event stream) as a reply. */
export function replyFromStream(format: ApiFormat, raw: string): Reply {
  let text = "";
  let model = "";
  let cut = false;
  const calls = new Map<number, { id: string; name: string; json: string }>();
  for (const e of sseData(raw)) {
    if (format === "openai") {
      if (typeof e.model === "string") model = e.model;
      const choice = Array.isArray(e.choices) ? e.choices[0] : undefined;
      if (!isObject(choice)) continue;
      if (choice.finish_reason === "length") cut = true;
      const delta = isObject(choice.delta) ? choice.delta : {};
      if (typeof delta.content === "string") text += delta.content;
      const deltaCalls = Array.isArray(delta.tool_calls)
        ? delta.tool_calls
        : [];
      for (const tc of deltaCalls) {
        if (!isObject(tc)) continue;
        const index = typeof tc.index === "number" ? tc.index : calls.size;
        const call = calls.get(index) ?? { id: "", name: "", json: "" };
        const fn = isObject(tc.function) ? tc.function : {};
        if (typeof tc.id === "string") call.id = tc.id;
        if (typeof fn.name === "string") call.name += fn.name;
        if (typeof fn.arguments === "string") call.json += fn.arguments;
        calls.set(index, call);
      }
      continue;
    }
    switch (e.type) {
      case "message_start":
        if (isObject(e.message)) model = String(e.message.model ?? "");
        break;
      case "content_block_start": {
        const block = isObject(e.content_block) ? e.content_block : {};
        if (block.type === "tool_use") {
          calls.set(Number(e.index), {
            id: String(block.id ?? ""),
            name: String(block.name ?? ""),
            json: "",
          });
        } else if (typeof block.text === "string") {
          text += block.text;
        }
        break;
      }
      case "content_block_delta": {
        const delta = isObject(e.delta) ? e.delta : {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          text += delta.text;
        } else if (
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          const call = calls.get(Number(e.index));
          if (call) call.json += delta.partial_json;
        }
        break;
      }
      case "message_delta":
        if (isObject(e.delta) && e.delta.stop_reason === "max_tokens") {
          cut = true;
        }
        break;
    }
  }
  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, c]) => ({ id: c.id, name: c.name, args: parseArgs(c.json) }));
  return { text, toolCalls, stop: stopOf(toolCalls.length > 0, cut), model };
}

// ------------------------------------------------- answers Hotpath writes itself

let counter = 0;
/** An id for a tool call or message Hotpath answers itself (marked `hp`). */
export function hotpathId(format: ApiFormat, kind: "call" | "msg"): string {
  counter += 1;
  const stamp = `${Date.now().toString(36)}${counter.toString(36)}`;
  if (format === "anthropic") {
    return kind === "call" ? `toolu_hp_${stamp}` : `msg_hp_${stamp}`;
  }
  return kind === "call" ? `call_hp_${stamp}` : `chatcmpl-hp${stamp}`;
}

const openAiFinish = (r: Reply) =>
  r.stop === "tool" ? "tool_calls" : r.stop === "length" ? "length" : "stop";
const anthropicStop = (r: Reply) =>
  r.stop === "tool"
    ? "tool_use"
    : r.stop === "length"
      ? "max_tokens"
      : "end_turn";

/** The reply as a non-streamed response body of the agent's API. */
export function replyToJson(format: ApiFormat, reply: Reply): Json {
  const id = hotpathId(format, "msg");
  if (format === "openai") {
    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: reply.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: reply.text.length > 0 ? reply.text : null,
            ...(reply.toolCalls.length > 0
              ? {
                  tool_calls: reply.toolCalls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: {
                      name: c.name,
                      arguments: JSON.stringify(c.args),
                    },
                  })),
                }
              : {}),
          },
          finish_reason: openAiFinish(reply),
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
  return {
    id,
    type: "message",
    role: "assistant",
    model: reply.model,
    content: [
      ...(reply.text.length > 0 ? [{ type: "text", text: reply.text }] : []),
      ...reply.toolCalls.map((c) => ({
        type: "tool_use",
        id: c.id,
        name: c.name,
        input: c.args,
      })),
    ],
    stop_reason: anthropicStop(reply),
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/** The reply as the server-sent event stream the agent's SDK expects. */
export function replyToStream(
  format: ApiFormat,
  reply: Reply,
  includeUsage = false,
): string {
  const id = hotpathId(format, "msg");
  if (format === "openai") {
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: Json, finish: string | null = null) =>
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: reply.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    let out = chunk({ role: "assistant", content: "" });
    if (reply.text.length > 0) out += chunk({ content: reply.text });
    reply.toolCalls.forEach((c, index) => {
      out += chunk({
        tool_calls: [
          {
            index,
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          },
        ],
      });
    });
    out += chunk({}, openAiFinish(reply));
    if (includeUsage) {
      out += `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: reply.model,
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })}\n\n`;
    }
    return out + "data: [DONE]\n\n";
  }
  const event = (name: string, data: Json) =>
    `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
  let out = event("message_start", {
    message: {
      id,
      type: "message",
      role: "assistant",
      model: reply.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  let index = 0;
  if (reply.text.length > 0) {
    out += event("content_block_start", {
      index,
      content_block: { type: "text", text: "" },
    });
    out += event("content_block_delta", {
      index,
      delta: { type: "text_delta", text: reply.text },
    });
    out += event("content_block_stop", { index });
    index += 1;
  }
  for (const c of reply.toolCalls) {
    out += event("content_block_start", {
      index,
      content_block: { type: "tool_use", id: c.id, name: c.name, input: {} },
    });
    out += event("content_block_delta", {
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(c.args) },
    });
    out += event("content_block_stop", { index });
    index += 1;
  }
  out += event("message_delta", {
    delta: { stop_reason: anthropicStop(reply), stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  return out + event("message_stop", {});
}

/** A tool result as the value the trace and the guards see: JSON when it is JSON. */
export function resultValue(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return content;
    }
  }
  return content;
}

/** The first user message of a conversation (what the agent was asked to do). */
export function firstUserText(conversation: Conversation): string {
  const first = conversation.messages.find((m) => m.role === "user");
  return first?.role === "user" ? first.text : "";
}

/** Every tool call the model made in the conversation so far, by id. */
export function toolCallsById(
  conversation: Conversation,
): Map<string, ToolCall> {
  const out = new Map<string, ToolCall>();
  for (const m of conversation.messages) {
    if (m.role === "assistant") for (const c of m.toolCalls) out.set(c.id, c);
  }
  return out;
}
