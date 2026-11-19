import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { TraceWriter } from "@hotpathrun/recorder";
import { assertTaskName, type TraceToolInfo } from "@hotpathrun/shared";

import {
  firstUserText,
  resultValue,
  type ApiFormat,
  type Conversation,
  type Reply,
  type ToolSpec,
} from "./formats.js";

/** `server` of a workflow recorded through the proxy: its tools run in the agent. */
export const PROXY_SERVER = "@hotpathrun/proxy";

/** What the agent was asked, with today's input values as `{{inputs.<name>}}`. */
export interface PromptTemplate {
  version: 1;
  task: string;
  format: ApiFormat;
  system: string;
  user: string;
}

interface Call {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  isError: boolean;
  startedAt: string;
  durationMs: number;
}

const MIN_INPUT_LENGTH = 2;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `value` on its own: not inside a longer word or number, nor part of a date
 * or version ("10" is not in "2026-10-01").
 */
const alone = (value: string, flags: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?<!\\p{N}[-./:])${escapeRegExp(value)}(?![\\p{L}\\p{N}])(?![-./:]\\p{N})`,
    flags,
  );

const mentionsAlone = (text: string, value: string) =>
  alone(value, "u").test(text);

/**
 * The inputs of a recorded conversation: argument values the model passed to a
 * tool that it took from what it was asked ("the report for 2026-10-01" →
 * get_orders(date="2026-10-01")). These are what changes between runs; the
 * compiler turns them into `{{inputs.<name>}}`. Values found only in tool
 * results (an order id the model read) are not inputs. The user message is
 * where a task's parameters usually are; the system prompt is looked at only
 * when the user message holds none, because it is mostly fixed instructions
 * ('send_report with to="ops"') that would otherwise become inputs too.
 */
export function inferInputs(
  calls: Array<{ args: Record<string, unknown> }>,
  user: string,
  system = "",
): Record<string, string> {
  const fromUser = inputsIn(calls, user);
  return Object.keys(fromUser).length > 0 ? fromUser : inputsIn(calls, system);
}

function inputsIn(
  calls: Array<{ args: Record<string, unknown> }>,
  prompt: string,
): Record<string, string> {
  const inputs: Record<string, string> = {};
  const taken = new Set<string>();
  for (const call of calls) {
    for (const [name, raw] of Object.entries(call.args)) {
      if (typeof raw !== "string" && typeof raw !== "number") continue;
      const value = String(raw);
      if (value.length < MIN_INPUT_LENGTH || taken.has(value)) continue;
      if (!mentionsAlone(prompt, value)) continue;
      let base = name.replace(/[^A-Za-z0-9_-]/g, "_");
      if (!/^[A-Za-z_]/.test(base)) base = `input_${base}`;
      let key = base;
      for (let i = 2; key in inputs; i++) key = `${base}_${i}`;
      inputs[key] = value;
      taken.add(value);
    }
  }
  return inputs;
}

/** `text` with each input's value replaced by its placeholder. */
export function templateOf(
  text: string,
  inputs: Record<string, string>,
): string {
  // longest values first: "2026-10-01" must not lose its "10" to another input
  const ordered = Object.entries(inputs).sort(
    ([, a], [, b]) => b.length - a.length,
  );
  let out = text;
  for (const [name, value] of ordered) {
    out = out.replace(alone(value, "gu"), `{{inputs.${name}}}`);
  }
  return out;
}

/** The inputs that turn `template` into `text`, or null when it does not fit. */
export function matchTemplate(
  template: string,
  text: string,
): Record<string, string> | null {
  const names: string[] = [];
  const pattern = template
    .split(/(\{\{inputs\.[A-Za-z0-9_-]+\}\})/)
    .map((part) => {
      const m = /^\{\{inputs\.([A-Za-z0-9_-]+)\}\}$/.exec(part);
      if (!m) return escapeRegExp(part);
      if (names.includes(m[1]!)) return `\\k<i${names.indexOf(m[1]!)}>`;
      names.push(m[1]!);
      return `(?<i${names.length - 1}>.+?)`;
    })
    .join("");
  const match = new RegExp(`^${pattern}$`, "s").exec(text);
  if (!match) return null;
  return Object.fromEntries(
    names.map((name, i) => [name, match.groups?.[`i${i}`] ?? ""]),
  );
}

/** The task name of a conversation recorded without `x-hotpath-task`. */
export function taskNameFor(system: string, user: string): string {
  const hash = createHash("sha256")
    .update(`${system}\n\u0000\n${user}`)
    .digest("hex")
    .slice(0, 10);
  return `proxy-${hash}`;
}

export interface RecordingOptions {
  /** `x-hotpath-task`; otherwise named after what the agent was asked */
  task?: string;
  /** `x-hotpath-inputs`; otherwise inferred from the conversation */
  inputs?: Record<string, string>;
  /** tools that only read: the rest are treated as actions (the safe mistake) */
  readOnly: ReadonlySet<string>;
}

/**
 * One conversation seen through the proxy, turned into a trace of the existing
 * format (SPEC §5.1): a tool call is complete when the agent sends its result
 * back in the next request. Kept in memory and written when the conversation
 * ends, because the meta line needs the inputs, which are only known then.
 */
export class ConversationRecording {
  private readonly calls = new Map<string, Call>();
  /** when the model asked for each call (its time runs until the result comes back) */
  private readonly issued = new Map<string, number>();
  private conversation: Conversation | null = null;
  private readonly startedAt = new Date().toISOString();
  private written: Promise<string | null> | null = null;

  constructor(private readonly options: RecordingOptions) {}

  /** Adds the tool calls this request completed (call + result). */
  observe(conversation: Conversation): void {
    this.conversation = conversation;
    const byId = new Map<
      string,
      { name: string; args: Record<string, unknown> }
    >();
    for (const m of conversation.messages) {
      if (m.role === "assistant") {
        for (const c of m.toolCalls) byId.set(c.id, c);
      }
    }
    for (const m of conversation.messages) {
      if (m.role !== "tool" || this.calls.has(m.callId)) continue;
      const call = byId.get(m.callId);
      if (!call) continue;
      const now = Date.now();
      const asked = this.issued.get(m.callId) ?? now;
      this.calls.set(m.callId, {
        tool: call.name,
        args: call.args,
        result: resultValue(m.content),
        isError: m.isError,
        startedAt: new Date(asked).toISOString(),
        durationMs: Math.max(0, now - asked),
      });
    }
  }

  /** The model's answer: the tool calls it asked for start now. */
  noteReply(reply: Reply): void {
    for (const c of reply.toolCalls) {
      if (!this.issued.has(c.id)) this.issued.set(c.id, Date.now());
    }
  }

  get callCount(): number {
    return this.calls.size;
  }

  /**
   * Writes traces/<task>/<time>.jsonl and, next to it, the prompt template the
   * replay matches new conversations against. Null when no tool was called.
   */
  finish(): Promise<string | null> {
    this.written ??= this.write();
    return this.written;
  }

  private async write(): Promise<string | null> {
    const conversation = this.conversation;
    if (!conversation || this.calls.size === 0) return null;
    const calls = [...this.calls.values()];
    const user = firstUserText(conversation);
    const inputs =
      this.options.inputs ?? inferInputs(calls, user, conversation.system);
    const system = templateOf(conversation.system, inputs);
    const userTemplate = templateOf(user, inputs);
    const task = assertTaskName(
      this.options.task ?? taskNameFor(system, userTemplate),
    );
    const writer = new TraceWriter(task);
    writer.writeMeta({
      version: 1,
      task,
      startedAt: this.startedAt,
      server: PROXY_SERVER,
      inputs,
      tools: toolInfo(conversation.tools, calls, this.options.readOnly),
    });
    for (const call of calls) {
      writer.write({ type: "tool_call", seq: writer.nextSeq(), ...call });
    }
    await writer.writeEnd(new Date().toISOString());
    const template: PromptTemplate = {
      version: 1,
      task,
      format: conversation.format,
      system,
      user: userTemplate,
    };
    // the prompt holds the customer's data like the trace: private to this user
    await writeFile(
      writer.file.replace(/\.jsonl$/, ".prompt.json"),
      JSON.stringify(template, null, 2) + "\n",
      { mode: 0o600 },
    );
    return writer.file;
  }
}

/** The tools as the trace lists them; a tool the request did not list still gets a line. */
function toolInfo(
  specs: ToolSpec[],
  calls: Call[],
  readOnly: ReadonlySet<string>,
): TraceToolInfo[] {
  const names = [
    ...new Set([...specs.map((s) => s.name), ...calls.map((c) => c.tool)]),
  ];
  return names.map((name) => ({
    name,
    inputSchema: specs.find((s) => s.name === name)?.inputSchema ?? {
      type: "object",
    },
    annotations: { readOnlyHint: readOnly.has(name) },
  }));
}
