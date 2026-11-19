// A Langfuse export: traces with their observations (GET /api/public/traces,
// {"data": [{id, observations: [...]}]}), or a flat list of observations
// (GET /api/public/v2/observations). Tool calls are observations of type TOOL;
// model calls are GENERATION observations with usage and cost.
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

type Obj = Record<string, unknown>;

const ms = (v: unknown) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};

function container(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (isObject(json) && Array.isArray(json.data)) return json.data;
  if (isObject(json) && Array.isArray(json.traces)) return json.traces;
  throw new ImportError(
    'not a Langfuse export: expected a list, or an object with a "data" list, of traces or observations',
  );
}

export function looksLikeLangfuse(json: unknown): boolean {
  try {
    const first = container(json).find(isObject);
    if (!first) return false;
    return (
      Array.isArray(first.observations) ||
      ("traceId" in first && "type" in first && !("run_type" in first))
    );
  } catch {
    return false;
  }
}

/** observations grouped by trace id */
function byTrace(json: unknown): Map<string, Obj[]> {
  const out = new Map<string, Obj[]>();
  const add = (trace: string, o: Obj) =>
    out.set(trace, [...(out.get(trace) ?? []), o]);
  for (const item of container(json)) {
    if (!isObject(item)) continue;
    if (Array.isArray(item.observations)) {
      const id = str(item.id) ?? "trace";
      out.set(id, out.get(id) ?? []);
      for (const o of item.observations) if (isObject(o)) add(id, o);
    } else {
      const id = str(item.traceId);
      if (id) add(id, item);
    }
  }
  return out;
}

function generationUsage(o: Obj): UsageLine {
  const d = isObject(o.usageDetails) ? o.usageDetails : {};
  const old = isObject(o.usage) ? o.usage : {};
  const cd = isObject(o.costDetails) ? o.costDetails : {};
  return {
    model: str(o.model) ?? str(o.providedModelName),
    input: num(d.input) ?? num(old.input) ?? num(o.inputUsage),
    output: num(d.output) ?? num(old.output) ?? num(o.outputUsage),
    cost: num(o.calculatedTotalCost) ?? num(o.totalCost) ?? num(cd.total),
  };
}

export function importLangfuse(json: unknown): ImportedRun[] {
  const runs: ImportedRun[] = [];
  for (const [traceId, obs] of byTrace(json)) {
    const calls: RawCall[] = [];
    const usage: UsageLine[] = [];
    for (const o of obs) {
      if (o.type === "TOOL") {
        const tool = str(o.name);
        if (!tool) continue;
        calls.push({
          tool,
          args: argsOf(o.input),
          result: jsonValue(o.output),
          isError: o.level === "ERROR",
          startMs: ms(o.startTime),
          endMs: ms(o.endTime) || ms(o.startTime),
        });
      } else if (o.type === "GENERATION") {
        usage.push(generationUsage(o));
      }
    }
    runs.push(
      toImportedRun({
        source: "langfuse",
        id: traceId,
        calls,
        usage: sumUsage(usage),
        finished: obs.every((o) => !!o.endTime),
      }),
    );
  }
  return runs;
}
