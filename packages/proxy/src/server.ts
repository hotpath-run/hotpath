import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { loadWorkflow, tracesDir, workflowsDir } from "@hotpathrun/compiler";
import {
  taskNameProblem,
  toolStepsOf,
  type LlmRoute,
  type Workflow,
} from "@hotpathrun/shared";

import {
  FormatError,
  firstUserText,
  fromAnthropicRequest,
  fromOpenAiRequest,
  replyFromJson,
  replyFromStream,
  replyToJson,
  replyToStream,
  type ApiFormat,
  type Conversation,
  type Reply,
  type ToolCall,
} from "./formats.js";
import {
  ConversationRecording,
  matchTemplate,
  type PromptTemplate,
} from "./record.js";
import { ReplaySession, type ReplayEvent } from "./replay.js";

export const DEFAULT_PORT = 8787;
export const DEFAULT_OPENAI_UPSTREAM = "https://api.openai.com/v1";
export const DEFAULT_ANTHROPIC_UPSTREAM = "https://api.anthropic.com";

/** Hosts the proxy may listen on: it holds the agent's key in flight, so never the network. */
export const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const IDLE_SESSION_MS = 10 * 60 * 1000;
/** Text the replay answers with once the workflow is done (see docs/PROXY.md). */
export const DONE_TEXT = "Done.";

export interface ProxyOptions {
  port?: number;
  host?: string;
  /** where Chat Completions requests go (an SDK baseURL, ending in /v1) */
  openaiUpstream?: string;
  /** where Messages requests go (an SDK baseURL, without /v1) */
  anthropicUpstream?: string;
  /** "auto": serve conversations that match a compiled workflow; "record": never */
  mode?: "auto" | "record";
  /** tools that only read (also per request: `x-hotpath-read-only: a,b`) */
  readOnly?: string[];
  /** how long after the model's last answer a conversation counts as over */
  endAfterMs?: number;
  /** one line per event; never given a key */
  log?: (line: string) => void;
}

export interface ProxyStats {
  requests: number;
  /** model turns Hotpath answered itself (no model call) */
  servedByHotpath: number;
  /** requests sent on to the model */
  forwarded: number;
  /** model calls the replays made for AI steps */
  aiStepCalls: number;
  replaysStarted: number;
  replaysFinished: number;
  handovers: number;
  tracesWritten: string[];
}

export interface RunningProxy {
  url: string;
  port: number;
  stats: ProxyStats;
  /** writes every conversation still open as a trace */
  flush(): Promise<string[]>;
  close(): Promise<void>;
}

/** Thrown for options the proxy refuses; the message says what to do. */
export class ProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyError";
  }
}

interface Session {
  kind: "record" | "replay";
  format: ApiFormat;
  prefix: string;
  lastSeen: number;
  messageCount: number;
  task?: string;
  inputs?: Record<string, string>;
  recording?: ConversationRecording;
  replay?: ReplaySession;
  /** actions already run in this conversation on the replay's word: never asked twice */
  actionsDone: ToolCall[];
  endTimer?: NodeJS.Timeout;
}

/** Headers the proxy itself reads; they are never sent upstream. */
interface HotpathHeaders {
  task?: string;
  inputs?: Record<string, string>;
  readOnly: string[];
  off: boolean;
}

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  // let the upstream answer uncompressed: the proxy reads what it passes on
  "accept-encoding",
]);

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function hotpathHeaders(req: IncomingMessage): HotpathHeaders {
  const task = header(req, "x-hotpath-task")?.trim();
  let inputs: Record<string, string> | undefined;
  const rawInputs = header(req, "x-hotpath-inputs");
  if (rawInputs) {
    try {
      const parsed: unknown = JSON.parse(rawInputs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        inputs = Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k, String(v)]),
        );
      }
    } catch {
      inputs = undefined;
    }
  }
  return {
    task: task && taskNameProblem(task) === null ? task : undefined,
    inputs,
    readOnly: (header(req, "x-hotpath-read-only") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    off: header(req, "x-hotpath-off") === "1",
  };
}

/** The agent's credentials, only to hide them from anything the proxy writes. */
function secretsOf(req: IncomingMessage): string[] {
  const out: string[] = [];
  const auth = header(req, "authorization");
  if (auth) out.push(auth, auth.replace(/^Bearer\s+/i, ""));
  const key = header(req, "x-api-key");
  if (key) out.push(key);
  return out.filter((s) => s.length >= 4);
}

/** `text` with every credential replaced: for logs and error messages. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(s).join("[key]");
  }
  return out;
}

function apiKeyOf(req: IncomingMessage): string {
  const key = header(req, "x-api-key");
  if (key) return key;
  return (header(req, "authorization") ?? "").replace(/^Bearer\s+/i, "");
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new ProxyError(
        `request body over ${MAX_BODY_BYTES / 1024 / 1024} MB`,
      );
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Which API a path belongs to, and the path under the upstream base URL. */
export function routeOf(pathname: string): {
  format: ApiFormat;
  chat: boolean;
  rest: string;
} {
  if (/^(\/v1)?\/messages(\/|$)/.test(pathname)) {
    return {
      format: "anthropic",
      chat: /^(\/v1)?\/messages$/.test(pathname),
      rest: pathname.replace(/^(\/v1)?/, "/v1"),
    };
  }
  return {
    format: "openai",
    chat: /^(\/v1)?\/chat\/completions$/.test(pathname),
    rest: pathname.replace(/^\/v1(?=\/|$)/, ""),
  };
}

const prefixKey = (c: Conversation) =>
  createHash("sha256")
    .update(`${c.format}\n${c.system}\n\u0000\n${firstUserText(c)}`)
    .digest("hex");

const sameCall = (a: ToolCall, b: ToolCall) =>
  a.name === b.name && JSON.stringify(a.args) === JSON.stringify(b.args);

/** Prompt templates of recorded tasks that have a workflow, newest first per task. */
async function templates(): Promise<PromptTemplate[]> {
  let tasks: string[];
  try {
    tasks = await readdir(tracesDir);
  } catch {
    return [];
  }
  const out: PromptTemplate[] = [];
  for (const task of tasks) {
    try {
      await access(path.join(workflowsDir, `${task}.json`));
      const files = (await readdir(path.join(tracesDir, task)))
        .filter((f) => f.endsWith(".prompt.json"))
        .sort()
        .reverse();
      for (const f of files) {
        out.push(
          JSON.parse(
            await readFile(path.join(tracesDir, task, f), "utf8"),
          ) as PromptTemplate,
        );
      }
    } catch {
      // no workflow, or no prompt recorded through the proxy
    }
  }
  return out;
}

/**
 * The model proxy: an agent points its model base URL here, nothing else
 * changes. Every conversation is recorded as a trace; a conversation that
 * matches a compiled workflow is answered from it (see ReplaySession), with
 * the model called only for AI steps, and handed back to the model on drift.
 * The agent's key is passed through on each request and never written down.
 */
export async function startProxy(
  options: ProxyOptions = {},
): Promise<RunningProxy> {
  const host = options.host ?? "127.0.0.1";
  if (!LOCAL_HOSTS.has(host)) {
    throw new ProxyError(
      `the proxy listens only on this computer (127.0.0.1, localhost or ::1), not ${JSON.stringify(host)}: ` +
        "it sees every model key and conversation passing through",
    );
  }
  const upstream: Record<ApiFormat, string> = {
    openai: (options.openaiUpstream ?? DEFAULT_OPENAI_UPSTREAM).replace(
      /\/+$/,
      "",
    ),
    anthropic: (
      options.anthropicUpstream ?? DEFAULT_ANTHROPIC_UPSTREAM
    ).replace(/\/+$/, ""),
  };
  const mode = options.mode ?? "auto";
  const endAfterMs = options.endAfterMs ?? 2000;
  const log = options.log ?? ((line: string) => console.log(line));
  const stats: ProxyStats = {
    requests: 0,
    servedByHotpath: 0,
    forwarded: 0,
    aiStepCalls: 0,
    replaysStarted: 0,
    replaysFinished: 0,
    handovers: 0,
    tracesWritten: [],
  };
  const sessions = new Set<Session>();
  const byCallId = new Map<string, Session>();

  const forgetCalls = (s: Session) => {
    for (const [id, owner] of byCallId) if (owner === s) byCallId.delete(id);
  };

  const finishRecording = async (s: Session): Promise<string | null> => {
    clearTimeout(s.endTimer);
    sessions.delete(s);
    forgetCalls(s);
    const file = (await s.recording?.finish()) ?? null;
    if (file) {
      stats.tracesWritten.push(file);
      log(
        `● recorded ${s.recording?.callCount ?? 0} tool call(s): ${path.basename(path.dirname(file))}/${path.basename(file)}`,
      );
    }
    return file;
  };

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const s of sessions) {
      if (now - s.lastSeen < IDLE_SESSION_MS) continue;
      if (s.kind === "replay") {
        s.replay?.stop("the agent went quiet");
        sessions.delete(s);
      } else void finishRecording(s);
    }
  }, 30_000);
  sweeper.unref();

  const findSession = (c: Conversation): Session | undefined => {
    for (let i = c.messages.length - 1; i >= 0; i--) {
      const m = c.messages[i]!;
      const ids =
        m.role === "tool"
          ? [m.callId]
          : m.role === "assistant"
            ? m.toolCalls.map((t) => t.id)
            : [];
      for (const id of ids) {
        const s = byCallId.get(id);
        if (s && sessions.has(s)) return s;
      }
    }
    // a turn without tool calls (the model answered in text, the agent asked again)
    const key = prefixKey(c);
    return [...sessions].find(
      (s) =>
        s.kind === "record" &&
        s.prefix === key &&
        s.messageCount < c.messages.length,
    );
  };

  /** The workflow and inputs for a new conversation, or why there are none. */
  const matchWorkflow = async (
    c: Conversation,
    h: HotpathHeaders,
  ): Promise<
    { workflow: Workflow; inputs: Record<string, string> } | { why: string }
  > => {
    let task = h.task;
    let inputs = h.inputs;
    if (!task || !inputs) {
      for (const t of await templates()) {
        if (t.format !== c.format || (task && t.task !== task)) continue;
        const fromSystem = matchTemplate(t.system, c.system);
        const fromUser = fromSystem && matchTemplate(t.user, firstUserText(c));
        if (!fromSystem || !fromUser) continue;
        task = t.task;
        inputs ??= { ...fromSystem, ...fromUser };
        break;
      }
    }
    if (!task) return { why: "no compiled workflow matches this conversation" };
    let workflow: Workflow;
    try {
      workflow = await loadWorkflow(task);
    } catch {
      return { why: `no compiled workflow for "${task}"` };
    }
    const given = inputs ?? {};
    const missing = Object.keys(workflow.inputs).filter((k) => !(k in given));
    if (missing.length > 0) {
      return {
        why: `"${task}" needs input(s) ${missing.join(", ")}: the request matched no recorded prompt (send x-hotpath-inputs)`,
      };
    }
    const offered = new Set(c.tools.map((t) => t.name));
    const absent = [
      ...new Set(toolStepsOf(workflow.steps).map((s) => s.tool)),
    ].filter((t) => offered.size > 0 && !offered.has(t));
    if (absent.length > 0) {
      return {
        why: `"${task}" calls ${absent.join(", ")}, which the agent did not offer the model`,
      };
    }
    return { workflow, inputs: given };
  };

  const send = (
    res: ServerResponse,
    c: Conversation,
    reply: Reply,
    source: "replay",
  ) => {
    if (c.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-hotpath": source,
      });
      res.end(replyToStream(c.format, reply, c.includeUsage));
    } else {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-hotpath": source,
      });
      res.end(JSON.stringify(replyToJson(c.format, reply)));
    }
  };

  const fail = (res: ServerResponse, status: number, message: string) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { type: "hotpath_proxy_error", message },
      }),
    );
  };

  const upstreamHeaders = (req: IncomingMessage): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (HOP_BY_HOP.has(name) || name.startsWith("x-hotpath-")) continue;
      out[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    return out;
  };

  /** Copies the upstream answer to the agent; returns the body it read (for the recording). */
  const relay = async (
    upstreamRes: Response,
    res: ServerResponse,
  ): Promise<string> => {
    const headers: Record<string, string> = { "x-hotpath": "forward" };
    upstreamRes.headers.forEach((value, name) => {
      // fetch already decoded the body; its length and encoding no longer hold
      if (
        name === "content-encoding" ||
        name === "content-length" ||
        name === "transfer-encoding" ||
        name === "connection"
      ) {
        return;
      }
      headers[name] = value;
    });
    res.writeHead(upstreamRes.status, headers);
    const decoder = new TextDecoder();
    let body = "";
    if (upstreamRes.body) {
      for await (const chunk of upstreamRes.body) {
        res.write(chunk);
        body += decoder.decode(chunk, { stream: true });
      }
    }
    body += decoder.decode();
    res.end();
    return body;
  };

  const callUpstream = (
    req: IncomingMessage,
    format: ApiFormat,
    rest: string,
    body: Buffer | string | undefined,
  ) =>
    fetch(`${upstream[format]}${rest}`, {
      method: req.method,
      headers: upstreamHeaders(req),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });

  /** Sends the conversation to the model and records what happens. */
  const forward = async (
    req: IncomingMessage,
    res: ServerResponse,
    raw: Record<string, unknown>,
    c: Conversation,
    s: Session,
    rest: string,
  ) => {
    stats.forwarded += 1;
    s.recording?.observe(c);
    s.messageCount = c.messages.length;
    clearTimeout(s.endTimer);
    let reply: Reply;
    if (s.actionsDone.length > 0) {
      // An action already ran on the replay's word. Ask without streaming so
      // that a call to repeat it can be taken out before the agent sees it.
      const body: Record<string, unknown> = { ...raw, stream: false };
      delete body.stream_options;
      const upstreamRes = await callUpstream(
        req,
        c.format,
        rest,
        JSON.stringify(body),
      );
      if (!upstreamRes.ok) {
        await relay(upstreamRes, res);
        return;
      }
      reply = replyFromJson(c.format, await upstreamRes.json());
      const repeats = reply.toolCalls.filter((t) =>
        s.actionsDone.some((done) => sameCall(done, t)),
      );
      if (repeats.length > 0) {
        reply.toolCalls = reply.toolCalls.filter((t) => !repeats.includes(t));
        const names = repeats.map((t) => t.name).join(", ");
        log(`⛔ not repeating ${names}: it already ran in this conversation`);
        if (reply.toolCalls.length === 0) {
          reply.stop = "stop";
          reply.text =
            `${reply.text}\n(Hotpath: ${names} already ran in this conversation with these arguments; it was not asked again.)`.trim();
        }
      }
      if (c.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "x-hotpath": "forward",
        });
        res.end(replyToStream(c.format, reply, c.includeUsage));
      } else {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-hotpath": "forward",
        });
        res.end(JSON.stringify(replyToJson(c.format, reply)));
      }
    } else {
      const upstreamRes = await callUpstream(
        req,
        c.format,
        rest,
        JSON.stringify(raw),
      );
      const text = await relay(upstreamRes, res);
      if (!upstreamRes.ok) return;
      const streamed = (upstreamRes.headers.get("content-type") ?? "").includes(
        "event-stream",
      );
      try {
        reply = streamed
          ? replyFromStream(c.format, text)
          : replyFromJson(c.format, JSON.parse(text));
      } catch {
        return; // not an answer the proxy can read: passed on, not recorded
      }
    }
    s.recording?.noteReply(reply);
    for (const t of reply.toolCalls) byCallId.set(t.id, s);
    if (reply.stop !== "tool") {
      // the model answered: the conversation is over unless the agent asks again
      s.endTimer = setTimeout(() => void finishRecording(s), endAfterMs);
    }
  };

  const recordSession = (
    c: Conversation,
    h: HotpathHeaders,
    extra: Partial<Session> = {},
  ): Session => {
    const s: Session = {
      kind: "record",
      format: c.format,
      prefix: prefixKey(c),
      lastSeen: Date.now(),
      messageCount: 0,
      task: h.task,
      inputs: h.inputs,
      actionsDone: [],
      ...extra,
    };
    s.recording = new ConversationRecording({
      task: s.task,
      inputs: s.inputs,
      readOnly: new Set([...(options.readOnly ?? []), ...h.readOnly]),
    });
    sessions.add(s);
    return s;
  };

  /** The replay stops; the model gets the conversation as the agent sent it. */
  const handOver = (
    s: Session,
    c: Conversation,
    reason: string,
    h: HotpathHeaders,
  ) => {
    const replay = s.replay!;
    stats.handovers += 1;
    log(`↪ ${replay.workflow.task}: handed to the model: ${reason}`);
    const actionsDone = replay.actionsRun();
    sessions.delete(s);
    // what the model does from here is recorded like any agent run, so the
    // next compile can learn the new situation
    const next = recordSession(c, h, {
      task: replay.workflow.task,
      inputs: replay.inputs,
      actionsDone,
    });
    for (const call of replay.issued) byCallId.set(call.id, next);
    return next;
  };

  /** Answers the agent from a replay event, or hands the conversation over. */
  const answerFromReplay = async (
    req: IncomingMessage,
    res: ServerResponse,
    raw: Record<string, unknown>,
    c: Conversation,
    s: Session,
    rest: string,
    h: HotpathHeaders,
    event: ReplayEvent,
  ) => {
    const replay = s.replay!;
    if (event.kind === "tool") {
      byCallId.set(event.call.id, s);
      stats.servedByHotpath += 1;
      send(
        res,
        c,
        { text: "", toolCalls: [event.call], stop: "tool", model: c.model },
        "replay",
      );
      return;
    }
    if (event.kind === "done") {
      stats.servedByHotpath += 1;
      stats.replaysFinished += 1;
      stats.aiStepCalls += event.metrics.llmCalls;
      sessions.delete(s);
      forgetCalls(s);
      log(
        `✓ ${replay.workflow.task}: served from the workflow (${replay.issued.length} tool call(s), ${event.metrics.llmCalls} model call(s) for AI steps)`,
      );
      send(
        res,
        c,
        { text: DONE_TEXT, toolCalls: [], stop: "stop", model: c.model },
        "replay",
      );
      return;
    }
    stats.aiStepCalls += event.llmCalls;
    const next = handOver(s, c, event.reason, h);
    await forward(req, res, raw, c, next, rest);
  };

  const handleChat = async (
    req: IncomingMessage,
    res: ServerResponse,
    format: ApiFormat,
    rest: string,
    body: Buffer,
  ) => {
    let raw: Record<string, unknown>;
    let c: Conversation;
    try {
      raw = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      c =
        format === "openai"
          ? fromOpenAiRequest(raw)
          : fromAnthropicRequest(raw);
    } catch (err) {
      if (!(err instanceof FormatError) && !(err instanceof SyntaxError)) {
        throw err;
      }
      // not a request the proxy understands: the provider answers it
      stats.forwarded += 1;
      await relay(await callUpstream(req, format, rest, body), res);
      return;
    }
    const h = hotpathHeaders(req);
    if (h.off) {
      stats.forwarded += 1;
      await relay(await callUpstream(req, format, rest, body), res);
      return;
    }

    let s = findSession(c);
    if (s) s.lastSeen = Date.now();

    if (s?.kind === "replay") {
      const replay = s.replay!;
      if (!replay.answer(c)) {
        await forward(
          req,
          res,
          raw,
          c,
          handOver(s, c, "the conversation changed", h),
          rest,
        );
        return;
      }
      s.messageCount = c.messages.length;
      await answerFromReplay(req, res, raw, c, s, rest, h, await replay.next());
      return;
    }

    if (!s) {
      const fresh = !c.messages.some((m) => m.role !== "user");
      if (mode === "auto" && fresh) {
        const match = await matchWorkflow(c, h);
        if ("workflow" in match) {
          const replay = new ReplaySession(
            match.workflow,
            match.inputs,
            format,
            routeFor(req, format, c.model),
          );
          s = {
            kind: "replay",
            format,
            prefix: prefixKey(c),
            lastSeen: Date.now(),
            messageCount: c.messages.length,
            task: match.workflow.task,
            inputs: match.inputs,
            replay,
            actionsDone: [],
          };
          sessions.add(s);
          stats.replaysStarted += 1;
          log(
            `▶ ${match.workflow.task}: answering from the compiled workflow (${Object.entries(
              match.inputs,
            )
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")})`,
          );
          replay.start();
          await answerFromReplay(
            req,
            res,
            raw,
            c,
            s,
            rest,
            h,
            await replay.next(),
          );
          return;
        }
        if (h.task) log(`· ${h.task}: recording (${match.why})`);
      }
      s = recordSession(c, h);
    }
    await forward(req, res, raw, c, s, rest);
  };

  /** AI steps of a replay: the agent's provider, key and model. */
  const routeFor = (
    req: IncomingMessage,
    format: ApiFormat,
    model: string,
  ): LlmRoute | null => {
    const apiKey = apiKeyOf(req);
    if (!apiKey) return null;
    const free = { inputPer1M: 0, outputPer1M: 0 };
    return {
      provider: format,
      baseURL: upstream[format],
      apiKey,
      cheapModel: model,
      strongModel: model,
      cheapPrices: free,
      strongPrices: free,
    };
  };

  const server = createServer((req, res) => {
    stats.requests += 1;
    const secrets = secretsOf(req);
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/hotpath/stats") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(stats));
        return;
      }
      const route = routeOf(url.pathname);
      const body = await readBody(req);
      if (req.method === "POST" && route.chat) {
        await handleChat(req, res, route.format, route.rest + url.search, body);
        return;
      }
      // models lists and the rest: passed on as they are
      stats.forwarded += 1;
      await relay(
        await callUpstream(req, route.format, route.rest + url.search, body),
        res,
      );
    })().catch((err: unknown) => {
      const message = redact(
        err instanceof Error ? err.message : String(err),
        secrets,
      );
      log(`✗ ${message}`);
      fail(
        res,
        err instanceof ProxyError ? 400 : 502,
        `Hotpath proxy: ${message}. Check that the upstream URL is right and reachable.`,
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const shown = host.includes(":") ? `[${host}]` : host;

  const flush = async () => {
    const files: string[] = [];
    for (const s of [...sessions]) {
      if (s.kind !== "record") continue;
      const file = await finishRecording(s);
      if (file) files.push(file);
    }
    return files;
  };

  return {
    url: `http://${shown}:${port}`,
    port,
    stats,
    flush,
    async close() {
      clearInterval(sweeper);
      for (const s of sessions) s.replay?.stop("the proxy stopped");
      await flush();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
