// OpenTelemetry GenAI spans, as an OTLP JSON export ({"resourceSpans": ...}).
// Tool calls are `execute_tool` spans (gen_ai.tool.name, and the opt-in
// gen_ai.tool.call.arguments / .result); model calls are spans with
// gen_ai.usage.input_tokens / output_tokens. A run is one trace id.
import {
  ImportError,
  argsOf,
  isObject,
  jsonValue,
  num,
  str,
  sumUsage,
  toImportedRun,
  type ImportedRun,
  type RawCall,
  type UsageLine,
} from "./types.js";

interface Span {
  traceId: string;
  name: string;
  startMs: number;
  endMs: number;
  attrs: Record<string, unknown>;
  failed: boolean;
}

function anyValue(v: unknown): unknown {
  if (!isObject(v)) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return num(v.intValue);
  if ("doubleValue" in v) return num(v.doubleValue);
  if ("boolValue" in v) return v.boolValue;
  if (isObject(v.arrayValue) && Array.isArray(v.arrayValue.values))
    return v.arrayValue.values.map(anyValue);
  if (isObject(v.kvlistValue)) return attrMap(v.kvlistValue.values);
  return undefined;
}

function attrMap(list: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(list)) return out;
  for (const kv of list) {
    if (isObject(kv) && typeof kv.key === "string")
      out[kv.key] = anyValue(kv.value);
  }
  return out;
}

const nanoToMs = (v: unknown) => {
  const n = num(v);
  return n === undefined ? 0 : n / 1e6;
};

export function looksLikeOtlp(json: unknown): boolean {
  return isObject(json) && Array.isArray(json.resourceSpans);
}

function spansOf(json: unknown): Span[] {
  if (!isObject(json) || !Array.isArray(json.resourceSpans))
    throw new ImportError(
      'not an OTLP JSON export: expected a top-level "resourceSpans" list',
    );
  const spans: Span[] = [];
  for (const rs of json.resourceSpans) {
    if (!isObject(rs) || !Array.isArray(rs.scopeSpans)) continue;
    for (const ss of rs.scopeSpans) {
      if (!isObject(ss) || !Array.isArray(ss.spans)) continue;
      for (const s of ss.spans) {
        if (!isObject(s) || typeof s.traceId !== "string") continue;
        const attrs = attrMap(s.attributes);
        const status = isObject(s.status) ? num(s.status.code) : undefined;
        spans.push({
          traceId: s.traceId,
          name: typeof s.name === "string" ? s.name : "",
          startMs: nanoToMs(s.startTimeUnixNano),
          endMs: nanoToMs(s.endTimeUnixNano),
          attrs,
          // STATUS_CODE_ERROR is 2 (or the string form)
          failed:
            status === 2 ||
            (isObject(s.status) && s.status.code === "STATUS_CODE_ERROR") ||
            attrs["error.type"] !== undefined,
        });
      }
    }
  }
  return spans;
}

export function importOtlp(json: unknown): ImportedRun[] {
  const byTrace = new Map<string, Span[]>();
  for (const s of spansOf(json)) {
    byTrace.set(s.traceId, [...(byTrace.get(s.traceId) ?? []), s]);
  }
  const runs: ImportedRun[] = [];
  for (const [traceId, spans] of byTrace) {
    const calls: RawCall[] = [];
    const usage: UsageLine[] = [];
    for (const s of spans) {
      const op = str(s.attrs["gen_ai.operation.name"]);
      if (op === "execute_tool" || str(s.attrs["gen_ai.tool.name"])) {
        const tool =
          str(s.attrs["gen_ai.tool.name"]) ??
          s.name.replace(/^execute_tool\s+/, "");
        if (!tool) continue;
        calls.push({
          tool,
          args: argsOf(s.attrs["gen_ai.tool.call.arguments"]),
          result: jsonValue(s.attrs["gen_ai.tool.call.result"]),
          isError: s.failed,
          startMs: s.startMs,
          endMs: s.endMs,
        });
      } else if (
        s.attrs["gen_ai.usage.input_tokens"] !== undefined ||
        s.attrs["gen_ai.usage.output_tokens"] !== undefined
      ) {
        usage.push({
          model:
            str(s.attrs["gen_ai.response.model"]) ??
            str(s.attrs["gen_ai.request.model"]),
          input: num(s.attrs["gen_ai.usage.input_tokens"]),
          output: num(s.attrs["gen_ai.usage.output_tokens"]),
        });
      }
    }
    runs.push(
      toImportedRun({
        source: "otlp",
        id: traceId,
        calls,
        usage: sumUsage(usage),
        finished: spans.every((s) => s.endMs > 0),
      }),
    );
  }
  return runs;
}
