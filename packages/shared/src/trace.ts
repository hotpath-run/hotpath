import { readFile } from "node:fs/promises";

import {
  traceEndSchema,
  traceLineSchema,
  traceMetaSchema,
  traceToolCallSchema,
  type TraceEnd,
  type TraceMeta,
  type TraceToolCall,
} from "./schemas.js";

export interface TraceFile {
  meta: TraceMeta;
  calls: TraceToolCall[];
  end: TraceEnd;
  /**
   * The recorder is still writing it (no end line yet): `end` is made up from
   * the last call. Happens with clients like Claude Code, which keep the MCP
   * server running for their whole session.
   */
  open?: boolean;
}

export interface ReadTraceOptions {
  /** accept a trace without an end line instead of throwing */
  allowOpen?: boolean;
}

// Read a .jsonl trace, validating every line against the schema.
export async function readTrace(
  file: string,
  options: ReadTraceOptions = {},
): Promise<TraceFile> {
  const lines = (await readFile(file, "utf8"))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const hasEnd = lines.some((l) => l.includes('"type":"end"'));
  // an open trace's last line can be half-written by the running recorder
  if (options.allowOpen && !hasEnd && lines.length > 0) {
    try {
      JSON.parse(lines[lines.length - 1]);
    } catch {
      lines.pop();
    }
  }
  const parsed = lines.map((l) => traceLineSchema.parse(JSON.parse(l)));
  const meta = parsed.find((l) => l.type === "meta");
  const end = parsed.find((l) => l.type === "end");
  if (!meta || (!end && !options.allowOpen)) {
    throw new Error(`trace ${file} is missing a meta or end line`);
  }
  const calls = parsed
    .filter((l) => l.type === "tool_call")
    .map((l) => traceToolCallSchema.parse(l));
  const parsedMeta = traceMetaSchema.parse(meta);
  if (end) {
    return { meta: parsedMeta, calls, end: traceEndSchema.parse(end) };
  }
  const last = calls[calls.length - 1];
  const endedAt = last
    ? new Date(Date.parse(last.startedAt) + last.durationMs).toISOString()
    : parsedMeta.startedAt;
  return {
    meta: parsedMeta,
    calls,
    end: { type: "end", endedAt, toolCalls: calls.length },
    open: true,
  };
}
