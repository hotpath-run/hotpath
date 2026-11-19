import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";

// An ordinary agent written with the OpenAI SDK: its own tools, its own loop.
// Nothing here knows about Hotpath. To put Hotpath in, change `baseURL` to the
// proxy (http://127.0.0.1:8787/v1); everything else stays as it is.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "../fixtures/orders.json");

/** Where send_report "sends": a file, like every demo tool in this repository. */
export const reportsFile = path.join(here, "../out/reports.json");

interface Order {
  id: string;
  customer: string;
  total: number;
}

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_orders",
      description: "The orders placed on a date",
      parameters: {
        type: "object",
        properties: { date: { type: "string", description: "ISO date" } },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_report",
      description: "Send the daily report to someone",
      parameters: {
        type: "object",
        properties: { to: { type: "string" }, text: { type: "string" } },
        required: ["to", "text"],
      },
    },
  },
];

async function getOrders(date: string): Promise<{ orders: Order[] }> {
  const all = JSON.parse(await readFile(fixtures, "utf8")) as Record<
    string,
    Order[]
  >;
  return { orders: all[date] ?? [] };
}

async function sendReport(to: string, text: string) {
  let sent: Array<{ to: string; text: string; at: string }> = [];
  try {
    sent = JSON.parse(await readFile(reportsFile, "utf8")) as typeof sent;
  } catch {
    sent = [];
  }
  sent.push({ to, text, at: new Date().toISOString() });
  await mkdir(path.dirname(reportsFile), { recursive: true });
  await writeFile(reportsFile, JSON.stringify(sent, null, 2));
  return { ok: true, id: `r${sent.length}` };
}

async function runTool(name: string, args: Record<string, unknown>) {
  if (name === "get_orders") return getOrders(String(args.date ?? ""));
  if (name === "send_report") {
    return sendReport(String(args.to ?? ""), String(args.text ?? ""));
  }
  return { error: `no tool named ${name}` };
}

export interface AgentOptions {
  baseURL: string;
  model: string;
  date: string;
  /** the provider key (Ollama takes any) */
  apiKey: string;
  maxTurns?: number;
}

export interface AgentResult {
  /** chat requests the agent made (each one a model call without Hotpath) */
  requests: number;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  answer: string;
  ms: number;
}

const SYSTEM =
  "You are the operations assistant of a small coffee wholesaler. " +
  "Write the daily orders report: read the day's orders with get_orders, then call " +
  'send_report with to="ops" and a short text that names every order with its id, ' +
  "customer and total. Then say that it is done.";

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const start = Date.now();
  const client = new OpenAI({
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    maxRetries: 0,
  });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Send the daily orders report for ${options.date}.`,
    },
  ];
  const result: AgentResult = { requests: 0, toolCalls: [], answer: "", ms: 0 };
  let nudged = false;
  for (let turn = 0; turn < (options.maxTurns ?? 8); turn++) {
    const response = await client.chat.completions.create({
      model: options.model,
      messages,
      tools: TOOLS,
    });
    result.requests += 1;
    const message = response.choices[0]!.message;
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      const sent = result.toolCalls.some((c) => c.name === "send_report");
      if (sent || nudged) {
        result.answer = message.content ?? "";
        break;
      }
      // a small model sometimes answers in text instead of sending: say so once
      nudged = true;
      messages.push({ role: "assistant", content: message.content ?? "" });
      messages.push({
        role: "user",
        content: "The report has not been sent. Call send_report now.",
      });
      continue;
    }
    messages.push({
      role: "assistant",
      content: message.content,
      tool_calls: calls,
    });
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<
          string,
          unknown
        >;
      } catch {
        args = {};
      }
      result.toolCalls.push({ name: call.function.name, args });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(await runTool(call.function.name, args)),
      });
    }
  }
  result.ms = Date.now() - start;
  return result;
}
