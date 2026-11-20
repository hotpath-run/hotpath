import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AGENT_MODEL,
  chat,
  usdCost,
  type ChatMessage,
  type LlmToolSpec,
} from "@hotpathrun/shared";

import { loadTaskConfig, repoRoot, splitCommand } from "./config.js";
import { actionNudge, actionToolNames, deferActions } from "./nudge.js";

/** How to start the recorder and the tool server when there is no hotpath.config.json (the installed `hotpath demo`). */
export interface AgentLaunch {
  /** argv of `hotpath record --task <task> --`, without the server command */
  recorder: string[];
  /** argv of the tool server the recorder wraps */
  server: string[];
  /** folder the recorder runs in (the project folder) */
  cwd: string;
  /** extra environment for the recorder and the tool server */
  env?: Record<string, string>;
}

export interface AgentOptions {
  task: string;
  date: string;
  launch?: AgentLaunch;
}

export interface AgentMetrics {
  durationMs: number;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** time spent waiting on rate-limit retries (included in durationMs) */
  rateLimitWaitMs: number;
}

const PROMPTS: Record<
  string,
  {
    system: (date: string) => string;
    user: string;
    maxTurns: number;
    /** false: finishing without an action is a valid outcome (no nudge) */
    nudge?: boolean;
  }
> = {
  "morning-brief": {
    system: (date) =>
      `You are a personal assistant. Today is ${date}. Produce the user's morning brief: ` +
      `read today's emails, calendar and the weather in Paris, then call send_message ` +
      `with to="me" and a concise brief that mentions every email subject, every event ` +
      `and the weather.`,
    user: "Please produce the morning brief now.",
    maxTurns: 12,
  },
  "weekly-report": {
    system: (date) =>
      `You are an engineering manager's assistant. The week ends on ${date}. Produce the ` +
      `weekly report: list the repositories; for each repository read its commits and its ` +
      `open issues; read the week's incidents and the details of each incident; read the ` +
      `deploys and uptime metrics. Make independent calls together in the same step. Then ` +
      `call send_message twice: once with to="team" and a summary that mentions every ` +
      `repository with its main changes and open issues, and once with to="manager" and a ` +
      `short executive summary that mentions each incident (id and title), the deploys ` +
      `count and the uptime. You must call send_message exactly twice (team, then manager) ` +
      `and only finish after both messages are sent.`,
    user: "Please produce the weekly report now and send both messages.",
    // models often make one tool call per turn, and this task needs 13
    maxTurns: 20,
  },
  // branches: a quiet day sends nothing (hotpath learns this from two recordings)
  "inbox-alert": {
    system: (date) =>
      `You are a personal assistant. Today is ${date}. Call get_inbox. If it returned ` +
      `any emails, call send_message with to="me" and a short alert that mentions every ` +
      `email subject and sender. If it returned no emails, do not call send_message: ` +
      `just answer that the inbox is empty.`,
    user: "Please check the inbox now.",
    maxTurns: 6,
    nudge: false,
  },
  // ---- the benchmark suite's office tasks (task 06), server: office.ts ----
  "ticket-pages": {
    system: (date) =>
      `You are a support lead's assistant. Today is ${date}. Call list_tickets for page 1 ` +
      `and keep calling it for the next page until next_page is null. Then call ` +
      `send_message with to="me" and a list that mentions the title of every ticket.`,
    user: "Please list all open tickets now.",
    maxTurns: 10,
  },
  "customer-lookup": {
    system: (date) =>
      `You are a customer-care assistant. Today is ${date}. Call get_latest_order, then ` +
      `get_customer with that order's customer id, then get_shipping with the order id. ` +
      `Then call send_message with to="me" and a note that mentions the order id, the ` +
      `customer's name and the carrier.`,
    user: "Please look up the latest order now.",
    maxTurns: 8,
  },
  "long-report": {
    system: (date) =>
      `You are a PMO assistant. Today is ${date}. Call list_projects; then for every ` +
      `project call get_project_status, get_project_risks and get_project_budget. Make ` +
      `independent calls together in the same step. Then call send_message with to="me" ` +
      `and a report that mentions every project by name with its status, main risk and ` +
      `budget used.`,
    user: "Please produce the project report now.",
    maxTurns: 20,
  },
  "flaky-sales": {
    system: (date) =>
      `You are a sales assistant. Today is ${date}. Call get_sales (if it fails, call it ` +
      `again). Then call send_message with to="me" and a summary that mentions every ` +
      `region with its revenue.`,
    user: "Please summarise today's sales now.",
    maxTurns: 8,
  },
  "two-places": {
    system: (date) =>
      `You are an on-call assistant. Today is ${date}. Call get_incident, then call ` +
      `send_message twice: first with to="oncall" and the incident id, title and service; ` +
      `then with to="status-page" and a one-line public notice mentioning the incident ` +
      `title. Finish only after both messages are sent.`,
    user: "Please announce today's incident now.",
    maxTurns: 8,
  },
  "invoice-total": {
    system: (date) =>
      `You are an accounts assistant. Today is ${date}. Call list_invoices, add up the ` +
      `amounts yourself, then call send_message with to="me" and a note that mentions ` +
      `every customer and the total amount owed.`,
    user: "Please total the unpaid invoices now.",
    maxTurns: 8,
  },
  "meeting-times": {
    system: (date) =>
      `You are a scheduling assistant. Today is ${date}. Call list_meetings. The times ` +
      `are UTC: convert each to the user's local time (use the utc_offset) as HH:MM. Then ` +
      `call send_message with to="me" and a schedule that mentions every meeting title ` +
      `with its local start time.`,
    user: "Please write my schedule for today now.",
    maxTurns: 8,
  },
  "bank-reconciliation": {
    system: (date) =>
      `You are a finance assistant doing the bank reconciliation for ${date}. Call ` +
      `list_bank_lines for page 1 and keep calling it for the next page until next_page is ` +
      `null. Call list_ledger. Every bank line whose ref has no ledger entry is unmatched. ` +
      `For each unmatched line whose currency is not EUR, call get_fx_rate and convert its ` +
      `amount to EUR (amount x eur_per_unit). Then call send_message with to="controller" ` +
      `and a report that mentions every unmatched ref with its description and EUR amount, ` +
      `and the total unmatched amount in EUR.`,
    user: "Please reconcile the bank account now.",
    maxTurns: 20,
  },
  // ---- branching tasks (task 03), server: triage.ts ----
  // different paths: the email's priority picks the one action
  "mail-triage": {
    system: (date) =>
      `You are an email triage assistant. Today is ${date}. Call get_email, then act on ` +
      `that one email by its priority: urgent → call page_oncall with its subject; ` +
      `normal → call add_to_digest with its subject; spam → call archive with its id; ` +
      `billing → call forward_to_finance with its subject. Call exactly one action tool.`,
    user: "Please triage today's email now.",
    maxTurns: 6,
  },
  // per-item rule: only the spam is archived
  "inbox-sweep": {
    system: (date) =>
      `You are a mailbox cleaner. Today is ${date}. Call get_mailbox. For every email ` +
      `whose category is spam call archive with that email's id, one call per email. ` +
      `Do not touch any other email. If there is no spam, do nothing and say so.`,
    user: "Please clean the mailbox now.",
    maxTurns: 12,
    nudge: false,
  },
  // heavy and real: two live web pages per company, 8 companies a day
  "lead-research": {
    system: (date) =>
      `You are a sales researcher. Today is ${date}. Call get_leads for today's date. Then, ` +
      `one company at a time and in the order given, call fetch_page on its homepage and ` +
      `then on its pricing page. When every company is done, call send_message once with ` +
      `to="sales" and a markdown table with one row per company: company, what it sells ` +
      `(one line), who it is for, free plan (yes/no), cheapest paid plan with its price ` +
      `(or "not shown").`,
    user: "Please research today's leads now and send the table.",
    // 1 + 16 page reads + 1 send, one call per turn on most models
    maxTurns: 24,
  },
  "inbox-digest": {
    system: (date) =>
      `You are a personal assistant. Today is ${date}. Produce the inbox digest: call ` +
      `get_inbox, then open every email with get_email, one at a time and in the order ` +
      `get_inbox returned them, then call send_message with to="me" and a digest that ` +
      `mentions every email's subject and sender with one line about its content.`,
    user: "Please produce the inbox digest now.",
    maxTurns: 16,
  },
};

function promptFor(task: string) {
  const entry = PROMPTS[task];
  if (!entry) {
    throw new Error(
      `no prompt for task "${task}" — demo-agent knows: ${Object.keys(PROMPTS).join(", ")}`,
    );
  }
  return entry;
}

export function systemPrompt(task: string, date: string): string {
  return promptFor(task).system(date);
}

/** Whether to push the model to act when it answers in text before acting. */
export function nudgesToAct(task: string): boolean {
  return promptFor(task).nudge !== false;
}

export function maxTurns(task: string): number {
  return promptFor(task).maxTurns;
}

export function userRequest(task: string): string {
  return promptFor(task).user;
}

export async function runAgent(options: AgentOptions): Promise<AgentMetrics> {
  const start = Date.now();
  const launch = options.launch;
  const server = launch ? "" : (await loadTaskConfig(options.task)).server;
  const root = launch?.cwd ?? repoRoot;

  // Connect to MCP *through* the recorder proxy so the run is traced:
  // `hotpath record --task <task> -- <server command from hotpath.config.json>`
  const [command, ...args] = launch
    ? [...launch.recorder, ...launch.server]
    : [
        process.execPath,
        "--import",
        "tsx",
        path.join(repoRoot, "packages/cli/src/index.ts"),
        "record",
        "--task",
        options.task,
        "--",
        ...splitCommand(server),
      ];
  const transport = new StdioClientTransport({
    command: command!,
    args,
    cwd: root,
    env: {
      ...(process.env as Record<string, string>),
      ...launch?.env,
      HOTPATH_INPUTS: JSON.stringify({ date: options.date }),
    },
  });
  const client = new Client({ name: "demo-agent", version: "0.1.0" });
  await client.connect(transport);

  let metrics: AgentMetrics;
  try {
    const { tools: mcpTools } = await client.listTools();
    const tools: LlmToolSpec[] = mcpTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema as Record<string, unknown>,
    }));

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(options.task, options.date) },
      { role: "user", content: userRequest(options.task) },
    ];

    let llmCalls = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let rateLimitWaitMs = 0;
    const actionTools = actionToolNames(
      mcpTools as Array<{
        name: string;
        annotations?: { readOnlyHint?: boolean };
      }>,
    );
    const calledTools: string[] = [];
    let nudges = 0;

    for (let turn = 0; turn < maxTurns(options.task); turn++) {
      const result = await chat({ model: AGENT_MODEL, messages, tools });
      llmCalls += result.llmCalls;
      promptTokens += result.promptTokens;
      completionTokens += result.completionTokens;
      rateLimitWaitMs += result.rateLimitWaitMs ?? 0;

      if (process.env.HOTPATH_DEBUG) {
        console.error(
          `[agent turn ${turn + 1}] tools: ${result.toolCalls.map((c) => c.name).join(", ") || "-"}` +
            (result.text ? ` | text: ${result.text.slice(0, 200)}` : ""),
        );
      }

      if (result.toolCalls.length === 0) {
        const nudge = nudgesToAct(options.task)
          ? actionNudge(actionTools, calledTools, nudges)
          : null;
        if (nudge === null) break;
        nudges++;
        if (process.env.HOTPATH_DEBUG) console.error(`[agent] nudge ${nudges}`);
        messages.push({ role: "assistant", content: result.text });
        messages.push({ role: "user", content: nudge });
        continue;
      }

      const { run, deferred } = deferActions(result.toolCalls, actionTools);
      if (deferred.length > 0 && process.env.HOTPATH_DEBUG) {
        console.error(
          `[agent] held back ${deferred.map((c) => c.name).join(", ")} until the reads return`,
        );
      }
      messages.push({
        role: "assistant",
        content: result.text,
        toolCalls: run,
      });
      for (const call of run) {
        calledTools.push(call.name);
        const toolResult = await client.callTool({
          name: call.name,
          arguments: call.arguments,
        });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: extractText(toolResult),
        });
      }
    }

    metrics = {
      durationMs: Date.now() - start,
      llmCalls,
      promptTokens,
      completionTokens,
      costUsd: usdCost(AGENT_MODEL, promptTokens, completionTokens),
      rateLimitWaitMs,
    };
  } finally {
    await client.close();
  }

  const outDir = path.join(root, "out");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "agent-run.json"),
    JSON.stringify(metrics, null, 2),
  );
  console.log(
    `agent run: ${metrics.llmCalls} llm calls, ${metrics.durationMs}ms, $${metrics.costUsd.toFixed(4)}` +
      (metrics.rateLimitWaitMs > 0
        ? ` (incl. ${metrics.rateLimitWaitMs}ms rate-limit wait)`
        : ""),
  );
  return metrics;
}

function extractText(result: unknown): string {
  const content = (
    result as { content?: Array<{ type: string; text?: string }> }
  ).content;
  const text = content?.find((c) => c.type === "text")?.text;
  if (text !== undefined) return text;
  return JSON.stringify(result);
}
