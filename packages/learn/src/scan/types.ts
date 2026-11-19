// What the importers produce: a trace in the format the rest of Hotpath reads,
// plus what the source said the run cost. Usage lives beside the trace because
// the trace format has no place for it.
import type { TraceFile, TraceToolCall } from "@hotpathrun/shared";

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  /** the cost the source reported, in USD, when it reported one */
  costUsd?: number;
  /** the model(s) the run called, most-used first */
  models: string[];
}

export interface ImportedRun {
  /** which export it came from: "otlp", "langsmith", "langfuse" or "hotpath" */
  source: string;
  /** the source's own run or trace id: shown nowhere in a report */
  id: string;
  trace: TraceFile;
  usage: RunUsage | null;
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;

/** A JSON value that an export may carry as text: parse it when it is. */
export function jsonValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

/** Tool arguments are an object; anything else is kept under one key. */
export function argsOf(v: unknown): Record<string, unknown> {
  const value = jsonValue(v);
  if (isObject(value)) return value;
  if (value === undefined || value === null || value === "") return {};
  return { input: value };
}

export interface RawCall {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  isError: boolean;
  startMs: number;
  endMs: number;
}

export interface RawRun {
  source: string;
  id: string;
  calls: RawCall[];
  usage: RunUsage | null;
  /** false when the run never ended (still running or cut off) */
  finished: boolean;
}

/** Build the run in Hotpath's trace format; calls are put in time order. */
export function toImportedRun(raw: RawRun): ImportedRun {
  const sorted = [...raw.calls].sort((a, b) => a.startMs - b.startMs);
  const iso = (ms: number) =>
    new Date(Number.isFinite(ms) ? ms : 0).toISOString();
  const calls: TraceToolCall[] = sorted.map((c, i) => ({
    type: "tool_call",
    seq: i + 1,
    tool: c.tool,
    args: c.args,
    result: c.result,
    isError: c.isError,
    startedAt: iso(c.startMs),
    durationMs: Math.max(0, c.endMs - c.startMs) || 0,
  }));
  const first = sorted[0]?.startMs ?? 0;
  const last = sorted[sorted.length - 1];
  const trace: TraceFile = {
    meta: {
      type: "meta",
      version: 1,
      task: "imported",
      startedAt: iso(first),
      server: raw.source,
      inputs: {},
      tools: [],
    },
    calls,
    end: {
      type: "end",
      endedAt: iso(last?.endMs ?? first),
      toolCalls: calls.length,
    },
    ...(raw.finished ? {} : { open: true }),
  };
  return { source: raw.source, id: raw.id, trace, usage: raw.usage };
}

export interface UsageLine {
  model?: string;
  input?: number;
  output?: number;
  cost?: number;
}

/** Sum usage lines; models ordered by how often they appear. */
export function sumUsage(lines: UsageLine[]): RunUsage | null {
  if (lines.length === 0) return null;
  const counts = new Map<string, number>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cost: number | undefined;
  for (const l of lines) {
    inputTokens += l.input ?? 0;
    outputTokens += l.output ?? 0;
    if (l.cost !== undefined) cost = (cost ?? 0) + l.cost;
    if (l.model) counts.set(l.model, (counts.get(l.model) ?? 0) + 1);
  }
  if (inputTokens + outputTokens === 0 && cost === undefined) return null;
  const models = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m);
  return {
    inputTokens,
    outputTokens,
    ...(cost !== undefined ? { costUsd: cost } : {}),
    models,
  };
}
