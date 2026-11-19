// A fake model provider and a fake agent for the proxy tests. Nothing here
// reaches a real model: the "model" is a script that reads the conversation.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  fromAnthropicRequest,
  fromOpenAiRequest,
  replyFromJson,
  replyFromStream,
  replyToJson,
  replyToStream,
  type ApiFormat,
  type Conversation,
  type Reply,
} from "../src/index.js";

export interface Order {
  id: string;
  customer: string;
  total: number;
}
export const DAY1: Order[] = [
  { id: "A-1001", customer: "Brasserie Lutèce", total: 412.5 },
  { id: "A-1002", customer: "Atelier Vernet", total: 89 },
];
export const DAY2: Order[] = [
  { id: "A-2001", customer: "Maison Colibri", total: 1250 },
  { id: "A-2002", customer: "Studio Petrichor", total: 64.9 },
  { id: "A-2003", customer: "Librairie Solstice", total: 230 },
];
export const DATA: Record<string, Order[]> = {
  "2026-10-01": DAY1,
  "2026-10-02": DAY2,
  "2026-10-03": DAY2,
};

export const report = (orders: Order[]) =>
  `Daily orders report\n` +
  orders.map((o) => `- ${o.id}: ${o.customer}`).join("\n") +
  `\n${orders.length} orders in total.`;

export interface UpstreamRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
  conversation: Conversation;
  /** a replay's AI step: one user message, no tools */
  aiStep: boolean;
}

export interface FakeUpstream {
  url: string;
  requests: UpstreamRequest[];
  /** the text AI-step requests get */
  aiText: string;
  /** replaces the scripted model for the next turns */
  script: ((c: Conversation) => Reply) | null;
  close(): Promise<void>;
}

let ids = 0;
const upstreamId = (format: ApiFormat) =>
  `${format === "openai" ? "call" : "toolu"}_up_${++ids}`;

/**
 * The model the recorded agent talks to: reads today's orders, then sends a
 * report naming every order, then says it is done. It reads the conversation
 * like a model would, so it also finishes a conversation handed over mid-way.
 */
export function scriptedModel(c: Conversation): Reply {
  const user = c.messages.find((m) => m.role === "user");
  const date =
    /\d{4}-\d{2}-\d{2}/.exec(user?.role === "user" ? user.text : "")?.[0] ?? "";
  const asked = new Map<string, string>();
  for (const m of c.messages) {
    if (m.role === "assistant")
      for (const t of m.toolCalls) asked.set(t.id, t.name);
  }
  const results = c.messages.filter((m) => m.role === "tool");
  const sent = results.some(
    (r) => r.role === "tool" && asked.get(r.callId) === "send_report",
  );
  const read = results.find(
    (r) => r.role === "tool" && asked.get(r.callId) === "get_orders",
  );
  const reply = (r: Omit<Reply, "model">): Reply => ({ ...r, model: c.model });
  if (sent)
    return reply({ text: "The report is sent.", toolCalls: [], stop: "stop" });
  if (read && read.role === "tool") {
    // a model reads a renamed field too (the handover test renames it)
    const data = JSON.parse(read.content) as {
      orders?: Order[];
      items?: Order[];
    };
    const orders = data.orders ?? data.items ?? [];
    return reply({
      text: "",
      toolCalls: [
        {
          id: upstreamId(c.format),
          name: "send_report",
          args: { to: "ops", text: report(orders) },
        },
      ],
      stop: "tool",
    });
  }
  return reply({
    text: "",
    toolCalls: [
      { id: upstreamId(c.format), name: "get_orders", args: { date } },
    ],
    stop: "tool",
  });
}

export async function startUpstream(): Promise<FakeUpstream> {
  const fake: FakeUpstream = {
    url: "",
    requests: [],
    aiText: "",
    script: null,
    close: async () => undefined,
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      const format: ApiFormat = path.includes("/messages")
        ? "anthropic"
        : "openai";
      const conversation =
        format === "openai"
          ? fromOpenAiRequest(body)
          : fromAnthropicRequest(body);
      const aiStep =
        conversation.tools.length === 0 &&
        conversation.messages.length === 1 &&
        conversation.messages[0]!.role === "user";
      fake.requests.push({
        path,
        headers: req.headers,
        body,
        conversation,
        aiStep,
      });
      const reply: Reply = aiStep
        ? {
            text: fake.aiText,
            toolCalls: [],
            stop: "stop",
            model: conversation.model,
          }
        : (fake.script ?? scriptedModel)(conversation);
      if (conversation.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(replyToStream(format, reply, conversation.includeUsage));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(replyToJson(format, reply)));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  fake.url = `http://127.0.0.1:${port}`;
  fake.close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return fake;
}

export const TOOL_SPECS = [
  {
    name: "get_orders",
    description: "The orders placed on a date",
    parameters: {
      type: "object",
      properties: { date: { type: "string" } },
      required: ["date"],
    },
  },
  {
    name: "send_report",
    description: "Send the daily report",
    parameters: {
      type: "object",
      properties: { to: { type: "string" }, text: { type: "string" } },
      required: ["to", "text"],
    },
  },
];

export interface AgentOptions {
  proxy: string;
  format: ApiFormat;
  stream: boolean;
  date: string;
  key: string;
  /** system prompt: unique per test, so recorded prompts never match another test's */
  system: string;
  headers?: Record<string, string>;
  /** what get_orders returns (default: the orders of the date) */
  getOrders?: (date: string) => unknown;
}

export interface AgentRun {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  final: string;
  /** x-hotpath of each answer: "replay" or "forward" */
  sources: string[];
  sent: Array<{ to: string; text: string }>;
}

/**
 * An agent's own loop, written against the raw API of its provider: it asks
 * the model, runs the tools the model asks for, sends the results back. The
 * only Hotpath thing about it is the base URL.
 */
export async function runAgent(o: AgentOptions): Promise<AgentRun> {
  const run: AgentRun = { calls: [], final: "", sources: [], sent: [] };
  const userText = `Send the daily report for ${o.date}.`;
  // the messages in the provider's own shape
  const messages: Array<Record<string, unknown>> =
    o.format === "openai"
      ? [
          { role: "system", content: o.system },
          { role: "user", content: userText },
        ]
      : [{ role: "user", content: userText }];
  for (let turn = 0; turn < 8; turn++) {
    const body =
      o.format === "openai"
        ? {
            model: "fake-model",
            stream: o.stream,
            messages,
            tools: TOOL_SPECS.map((t) => ({ type: "function", function: t })),
          }
        : {
            model: "fake-model",
            max_tokens: 1024,
            stream: o.stream,
            system: o.system,
            messages,
            tools: TOOL_SPECS.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          };
    const res = await fetch(
      `${o.proxy}${o.format === "openai" ? "/v1/chat/completions" : "/v1/messages"}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(o.format === "openai"
            ? { authorization: `Bearer ${o.key}` }
            : { "x-api-key": o.key, "anthropic-version": "2023-06-01" }),
          ...o.headers,
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok)
      throw new Error(`proxy answered ${res.status}: ${await res.text()}`);
    run.sources.push(res.headers.get("x-hotpath") ?? "");
    const text = await res.text();
    const reply = o.stream
      ? replyFromStream(o.format, text)
      : replyFromJson(o.format, JSON.parse(text));
    if (reply.toolCalls.length === 0) {
      run.final = reply.text;
      break;
    }
    const results: Array<{ id: string; content: string }> = [];
    for (const call of reply.toolCalls) {
      run.calls.push({ name: call.name, args: call.args });
      let value: unknown;
      if (call.name === "get_orders") {
        const date = String(call.args.date);
        value = o.getOrders ? o.getOrders(date) : { orders: DATA[date] ?? [] };
      } else {
        run.sent.push(call.args as { to: string; text: string });
        value = { ok: true, id: `r${run.sent.length}` };
      }
      results.push({ id: call.id, content: JSON.stringify(value) });
    }
    if (o.format === "openai") {
      messages.push({
        role: "assistant",
        content: reply.text || null,
        tool_calls: reply.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });
      for (const r of results) {
        messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
      }
    } else {
      messages.push({
        role: "assistant",
        content: [
          ...(reply.text ? [{ type: "text", text: reply.text }] : []),
          ...reply.toolCalls.map((c) => ({
            type: "tool_use",
            id: c.id,
            name: c.name,
            input: c.args,
          })),
        ],
      });
      messages.push({
        role: "user",
        content: results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
        })),
      });
    }
  }
  return run;
}
