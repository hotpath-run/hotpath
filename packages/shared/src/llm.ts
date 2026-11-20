import Anthropic from "@anthropic-ai/sdk";
import { config as loadDotenv } from "dotenv";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";

import { anthropicChat } from "./llm-anthropic.js";
import { stripThinking, toolCallsFromText } from "./model-output.js";
import { projectRoot } from "./paths.js";

// Load .env from the working folder, else from the project folder (agents and
// bench run from package dirs via pnpm --filter; an installed hotpath is
// started by an agent from the agent's own folder).
const candidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../../.env"),
  path.join(projectRoot(), ".env"),
];
for (const candidate of candidates) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate });
    break;
  }
}

export const AGENT_MODEL = process.env.HOTPATH_AGENT_MODEL ?? "kimi-k3";
export const CHEAP_MODEL = process.env.HOTPATH_CHEAP_MODEL ?? "kimi-k2.7-code";

// LLM_API_KEY/LLM_BASE_URL (NVIDIA Cloud etc.); MOONSHOT_* kept as fallback.
const BASE_URL =
  process.env.LLM_BASE_URL ??
  process.env.MOONSHOT_BASE_URL ??
  "https://api.moonshot.ai/v1";

let client: OpenAI | null = null;

/**
 * Models that answered reasoning_effort with a 400/422 (not a reasoning model,
 * or one whose reasoning can't be turned off): don't send it again, which
 * would cost a failed round trip on every call.
 */
const rejectsReasoningEffort = new Set<string>();

/**
 * Where one hosted run's model calls go. The cloud runner serves several kinds of
 * member from one process (testers on a free OpenAI-compatible tier, paid members on
 * Anthropic), so the provider, key and models are set per run instead of from the
 * environment. Inside withLlmRoute, chat() maps the cheap and strong model names the
 * runtime asks for to the route's models, and usdCost() uses the route's prices.
 */
export interface LlmRoute {
  provider: "openai" | "anthropic";
  /** OpenAI-compatible endpoint (provider "openai"), or another Anthropic endpoint */
  baseURL?: string;
  apiKey: string;
  cheapModel: string;
  strongModel: string;
  cheapPrices: { inputPer1M: number; outputPer1M: number };
  strongPrices: { inputPer1M: number; outputPer1M: number };
}

const routeStore = new AsyncLocalStorage<LlmRoute>();

/** Runs fn with every chat() inside it (awaited or not) sent along route. */
export function withLlmRoute<T>(
  route: LlmRoute,
  fn: () => Promise<T>,
): Promise<T> {
  return routeStore.run(route, fn);
}

/** The route of the run in progress, if any. */
export function currentLlmRoute(): LlmRoute | undefined {
  return routeStore.getStore();
}

interface RouteClientFactories {
  openai?: (route: LlmRoute) => OpenAI;
  anthropic?: (route: LlmRoute) => Anthropic;
}
let routeFactories: RouteClientFactories | null = null;
const routeClients = new Map<string, OpenAI | Anthropic>();

/** Test seam: build route clients with fakes (or null to reset). */
export function setRouteClientsForTesting(
  factories: RouteClientFactories | null,
): void {
  routeFactories = factories;
  routeClients.clear();
}

/** One client per provider, endpoint and key, reused across runs. */
function routeClient(route: LlmRoute): OpenAI | Anthropic {
  const key = [route.provider, route.baseURL ?? "", route.apiKey].join("|");
  let made = routeClients.get(key);
  if (!made) {
    // maxRetries 0: callWithRetries measures rate-limit waits itself
    made =
      route.provider === "anthropic"
        ? (routeFactories?.anthropic?.(route) ??
          new Anthropic({
            apiKey: route.apiKey,
            // the model proxy sends AI steps to the agent's own endpoint
            ...(route.baseURL ? { baseURL: route.baseURL } : {}),
            maxRetries: 0,
          }))
        : (routeFactories?.openai?.(route) ??
          new OpenAI({
            apiKey: route.apiKey,
            baseURL: route.baseURL,
            maxRetries: 0,
          }));
    routeClients.set(key, made);
  }
  return made;
}

/** Test seam: inject a fake client (or null to reset). */
export function setClientForTesting(fake: OpenAI | null): void {
  client = fake;
  rejectsReasoningEffort.clear();
}

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.LLM_API_KEY ?? process.env.MOONSHOT_API_KEY;
    if (!apiKey) {
      throw new Error(
        "LLM_API_KEY is not set — copy .env.example to .env and fill it in",
      );
    }
    // maxRetries 0: we retry ourselves (see callWithRetries) so the time spent
    // waiting on rate limits is measured instead of hidden inside the SDK.
    client = new OpenAI({ apiKey, baseURL: BASE_URL, maxRetries: 0 });
  }
  return client;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Provider data that must go back with the call (Gemini 3 `extra_content.google.thought_signature`: without it the next turn is a 400). Opaque to Hotpath. */
  extra?: unknown;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmResult {
  text: string | null;
  toolCalls: LlmToolCall[];
  promptTokens: number;
  completionTokens: number;
  llmCalls: number;
  /** time spent sleeping between retries of rate-limited (429) requests */
  rateLimitWaitMs?: number;
  /** the answer stopped at max_tokens */
  truncated?: boolean;
}

/** "none" turns thinking off on Ollama (qwen3: ~8x faster, see docs/BENCHMARK.md). */
export type ReasoningEffort = "none" | "low" | "medium" | "high";

/**
 * HOTPATH_CHEAP_REASONING: unset/empty = "none". A replay step rewrites known
 * data in a known format; thinking made it 2-20x slower without making it more
 * right (docs/BENCHMARK.md), and the guards catch a bad answer either way.
 * "default" sends nothing: the provider's own default.
 */
export function parseReasoningEffort(
  raw: string | undefined,
): ReasoningEffort | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return "none";
  if (value === "default") return undefined;
  if (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  ) {
    return value;
  }
  throw new Error(
    `HOTPATH_CHEAP_REASONING="${raw}" is not valid — use none, low, medium, high or default (or leave it unset for none)`,
  );
}

/** Reasoning effort for the cheap model (workflow llm steps), read from the env on use. */
export function cheapReasoning(): ReasoningEffort | undefined {
  return parseReasoningEffort(process.env.HOTPATH_CHEAP_REASONING);
}

/**
 * Token cap for one workflow llm call. Small and always-reasoning models
 * sometimes think in a loop: qwen3 1.7B spent 42k tokens (5+ minutes) on one
 * weekly-report replay, ERNIE 5.5 Flash 41k (docs/BENCHMARK.md). Normal replays
 * used under 15k; a capped runaway becomes drift (the agent runs) instead.
 */
export const DEFAULT_CHEAP_MAX_TOKENS = 16_000;

/** HOTPATH_CHEAP_MAX_TOKENS: unset = default, 0 = no cap. */
export function parseMaxTokens(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return DEFAULT_CHEAP_MAX_TOKENS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `HOTPATH_CHEAP_MAX_TOKENS="${raw}" is not valid — use a whole number of tokens, or 0 for no cap`,
    );
  }
  return n === 0 ? undefined : n;
}

/** Token cap for the cheap model (workflow llm steps), read from the env on use. */
export function cheapMaxTokens(): number | undefined {
  return parseMaxTokens(process.env.HOTPATH_CHEAP_MAX_TOKENS);
}

const MAX_RATE_LIMIT_RETRIES = 6;
const MAX_SERVER_RETRIES = 2;
/** per-minute limits ask for up to ~60s: wait. A longer retry-after is a quota (e.g. daily tokens): fail fast. */
export const MAX_RETRY_WAIT_MS = 65_000;

type HeaderBag = Record<string, string | null | undefined> | undefined;

/** HTTP status of an error from either SDK (undefined for network errors). */
function errorStatus(err: unknown): number | undefined {
  return err instanceof OpenAI.APIError || err instanceof Anthropic.APIError
    ? err.status
    : undefined;
}

/** Response headers of an error from either SDK, as a plain object. */
function errorHeaders(err: unknown): HeaderBag {
  const headers = (err as { headers?: unknown } | null)?.headers;
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return headers as HeaderBag;
}

const isConnectionError = (err: unknown): boolean =>
  err instanceof OpenAI.APIConnectionError ||
  err instanceof Anthropic.APIConnectionError;

/** How long to wait before retrying: provider hint first, else backoff. */
export function retryDelayMs(headers: HeaderBag, attempt: number): number {
  const ms = Number(headers?.["retry-after-ms"]);
  if (headers?.["retry-after-ms"] != null && Number.isFinite(ms) && ms >= 0) {
    return ms;
  }
  const after = headers?.["retry-after"];
  if (after != null) {
    const seconds = Number(after);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(after);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  // 1+2+4+8+16+30 s: six retries outlast a per-minute window even when the
  // provider gives no readable hint (Gemini's free tier puts it in the body)
  return Math.min(30_000, 1000 * 2 ** attempt);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * create() with our own retries. Only waiting caused by 429s is added to
 * `waited.ms`; 5xx/connection retries happen too but are real latency.
 */
export async function callWithRetries<T>(
  call: () => Promise<T>,
  waited: { ms: number },
): Promise<T> {
  let rateLimited = 0;
  let serverErrors = 0;
  for (;;) {
    try {
      return await call();
    } catch (err) {
      if (errorStatus(err) === 429) {
        const delay = retryDelayMs(errorHeaders(err), rateLimited);
        if (
          rateLimited >= MAX_RATE_LIMIT_RETRIES ||
          delay > MAX_RETRY_WAIT_MS
        ) {
          throw err;
        }
        const started = Date.now();
        await sleep(delay);
        // Date.now() ticks in whole ms, so a sleep can measure ~1ms short
        waited.ms += Math.max(delay, Date.now() - started);
        rateLimited++;
        continue;
      }
      const status = errorStatus(err);
      const transient =
        isConnectionError(err) || (status !== undefined && status >= 500);
      if (transient && serverErrors < MAX_SERVER_RETRIES) {
        await sleep(500 * 2 ** serverErrors);
        serverErrors++;
        continue;
      }
      throw err;
    }
  }
}

/** Where model calls go (LLM_BASE_URL, else the default), for `hotpath doctor`. */
export function llmBaseUrl(): string {
  return BASE_URL;
}

/**
 * The model ids the provider lists (GET /models), for `hotpath doctor`: it
 * proves the URL and key work without spending tokens. Capped at 1,000 ids.
 */
export async function listModels(): Promise<string[]> {
  const ids: string[] = [];
  for await (const model of getClient().models.list()) {
    ids.push(model.id);
    if (ids.length >= 1000) break;
  }
  return ids;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: LlmToolSpec[];
  /** sent as reasoning_effort; dropped (once) if the provider rejects it */
  reasoningEffort?: ReasoningEffort;
  /** sent as max_tokens (thinking included on most providers) */
  maxTokens?: number;
}

// The ONLY place in the repo that talks to an LLM API (llm-anthropic.ts is its
// Anthropic half and is imported only from here).
export async function chat(options: ChatOptions): Promise<LlmResult> {
  const route = routeStore.getStore();
  if (!route) return openAiChat(getClient(), options);
  const model =
    options.model === AGENT_MODEL ? route.strongModel : route.cheapModel;
  const client = routeClient(route);
  return route.provider === "anthropic"
    ? anthropicChat(client as Anthropic, { ...options, model }, callWithRetries)
    : openAiChat(client as OpenAI, { ...options, model });
}

async function openAiChat(
  client: OpenAI,
  options: ChatOptions,
): Promise<LlmResult> {
  const request = {
    model: options.model,
    ...(options.maxTokens !== undefined
      ? { max_tokens: options.maxTokens }
      : {}),
    messages: options.messages.map(toOpenAiMessage),
    tools: options.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
    tool_choice:
      options.tools && options.tools.length > 0 ? ("auto" as const) : undefined,
  };
  const completions = client.chat.completions;
  const waited = { ms: 0 };
  let response;
  if (
    options.reasoningEffort === undefined ||
    rejectsReasoningEffort.has(options.model)
  ) {
    response = await callWithRetries(() => completions.create(request), waited);
  } else {
    try {
      response = await callWithRetries(
        () =>
          completions.create({
            ...request,
            // the SDK's type predates "none", which Ollama understands
            reasoning_effort: options.reasoningEffort as "low",
          }),
        waited,
      );
    } catch (err) {
      // Not every provider/model knows reasoning_effort: retry without it.
      const status = err instanceof OpenAI.APIError ? err.status : undefined;
      if (status !== 400 && status !== 422) throw err;
      rejectsReasoningEffort.add(options.model);
      response = await callWithRetries(
        () => completions.create(request),
        waited,
      );
    }
  }

  const choice = response.choices[0];
  let toolCalls: LlmToolCall[] = (choice.message.tool_calls ?? []).map(
    (tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParseJson(tc.function.arguments),
      ...extraOf(tc),
    }),
  );
  let text =
    choice.message.content == null
      ? null
      : stripThinking(choice.message.content);
  // Small open models often write the call as JSON in the text instead.
  if (toolCalls.length === 0 && text && options.tools?.length) {
    const recovered = toolCallsFromText(
      text,
      options.tools.map((t) => t.name),
    );
    if (recovered.calls.length > 0) {
      toolCalls = recovered.calls;
      text = recovered.rest || null;
    }
  }

  return {
    text,
    toolCalls,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
    llmCalls: 1,
    rateLimitWaitMs: waited.ms,
    truncated: choice.finish_reason === "length",
  };
}

function toOpenAiMessage(
  m: ChatMessage,
): OpenAI.Chat.ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls?.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          ...(tc.extra === undefined ? {} : { extra_content: tc.extra }),
        })),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
}

function extraOf(tc: object): { extra?: unknown } {
  const extra = (tc as { extra_content?: unknown }).extra_content;
  return extra === undefined ? {} : { extra };
}

function safeParseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
