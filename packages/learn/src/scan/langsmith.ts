// A LangSmith run export: a JSON list of run objects (or {"runs": [...]}), each
// with run_type, trace_id, parent_run_id, inputs/outputs, error and token
// counts. Tool calls are the runs with run_type "tool"; a run is one trace_id.
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

const ms = (v: unknown) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};

function runList(json: unknown): Record<string, unknown>[] {
  const list = Array.isArray(json)
    ? json
    : isObject(json) && Array.isArray(json.runs)
      ? json.runs
      : null;
  if (!list)
    throw new ImportError(
      'not a LangSmith export: expected a JSON list of runs (or an object with a "runs" list)',
    );
  return list.filter(isObject);
}

export function looksLikeLangSmith(json: unknown): boolean {
  try {
    const first = runList(json)[0];
    return !!first && "run_type" in first;
  } catch {
    return false;
  }
}

/** A tool run's input: LangChain wraps it as {"input": "<json text>"}. */
function toolArgs(inputs: unknown): Record<string, unknown> {
  if (isObject(inputs) && Object.keys(inputs).length === 1 && "input" in inputs)
    return argsOf(inputs.input);
  return argsOf(inputs);
}

export function importLangSmith(json: unknown): ImportedRun[] {
  const byTrace = new Map<string, Record<string, unknown>[]>();
  for (const r of runList(json)) {
    const id = str(r.trace_id) ?? str(r.id);
    if (!id) continue;
    byTrace.set(id, [...(byTrace.get(id) ?? []), r]);
  }
  const runs: ImportedRun[] = [];
  for (const [traceId, rs] of byTrace) {
    const calls: RawCall[] = [];
    const usage: UsageLine[] = [];
    for (const r of rs) {
      if (r.run_type === "tool") {
        const tool = str(r.name);
        if (!tool) continue;
        calls.push({
          tool,
          args: toolArgs(r.inputs),
          result:
            isObject(r.outputs) && "output" in r.outputs
              ? jsonValue(r.outputs.output)
              : r.outputs,
          isError: r.error !== null && r.error !== undefined && r.error !== "",
          startMs: ms(r.start_time),
          endMs: ms(r.end_time) || ms(r.start_time),
        });
      } else if (r.run_type === "llm") {
        const extra = isObject(r.extra) ? r.extra : {};
        const meta = isObject(extra.metadata) ? extra.metadata : {};
        usage.push({
          model: str(meta.ls_model_name) ?? str(r.model_name),
          input: num(r.prompt_tokens),
          output: num(r.completion_tokens),
          cost: num(r.total_cost),
        });
      }
    }
    const root = rs.find((r) => !r.parent_run_id) ?? rs[0]!;
    runs.push(
      toImportedRun({
        source: "langsmith",
        id: traceId,
        calls,
        usage: sumUsage(usage),
        finished: !!root.end_time,
      }),
    );
  }
  return runs;
}
