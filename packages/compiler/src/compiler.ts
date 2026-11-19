import {
  answerKey,
  countItems,
  DEFAULT_MAX_ITEMS,
  mentions,
  normalizeText,
  renderTemplate,
  type Condition,
  type DroppedCall,
  type GroundingEntry,
  type TraceFile,
  type Workflow,
  type WorkflowStep,
} from "@hotpathrun/shared";
import { features, learnRule, type Feature } from "./rules.js";

import { collapsePages } from "./pages.js";
import { relaxPositional, withSelectionRules } from "./grounding.js";
import { inferLayout } from "./layout.js";

// Deterministic trace → workflow compiler (SPEC §6 M5). Needs no API key.

const LLM_TEXT_MIN_CHARS = 40;

/** An earlier step's recorded value: a tool `result`, or a loop's `results`. */
interface Earlier {
  id: string;
  field: "result" | "results";
  result: unknown;
}

interface ReadOnlyResult extends Earlier {
  tool: string;
}

/** List items in the data the recording read: the length limit grows with it. */
function recordedItemCount(results: { result: unknown }[]): number {
  return results.reduce((n, r) => n + countItems(r.result), 0);
}

export function compileTrace(trace: TraceFile, compiledFrom: string): Workflow {
  return compileTraceDetailed(trace, compiledFrom).workflow;
}

/** What each step returned in the recording (tool `result`, loop `results`). */
export interface RecordedResult {
  id: string;
  field: "result" | "results";
  result: unknown;
}

/** compileTrace, plus each step's recorded result (branch learning compares them). */
export function compileTraceDetailed(
  trace: TraceFile,
  compiledFrom: string,
): { workflow: Workflow; recorded: RecordedResult[] } {
  const steps: WorkflowStep[] = [];
  // earlier steps' recorded results, for data-flow matching (rule 3)
  const earlier: Earlier[] = [];
  const annotationsByTool = new Map(
    trace.meta.tools.map((t) => [t.name, t.annotations]),
  );
  const readOnlyResults: ReadOnlyResult[] = [];

  const inputEntries = Object.entries(trace.meta.inputs);

  // rule 0: calls that errored never become steps. A real agent often retries
  // (wrong arguments, then right ones); replaying its mistakes would repeat the
  // errors, or worse, send a message twice.
  const split = splitFailedCalls(trace);
  const dropped = split.dropped;
  // rule 11: pages of one read ("until there is no next page") become one step
  const { calls: kept, paginate } = collapsePages(
    split.kept,
    (tool) => annotationsByTool.get(tool)?.readOnlyHint === true,
  );

  let nextId = 1;
  const newId = () => `s${nextId++}`;
  const isSideEffect = (tool: string) =>
    !(annotationsByTool.get(tool)?.readOnlyHint === true);

  // rules 2, 3 and 5 for one argument value; null when none applies
  const templateValue = (value: unknown): unknown => {
    const inputName = inputEntries.find(([, v]) => deepEqual(v, value))?.[0];
    if (inputName !== undefined) return `{{inputs.${inputName}}}`;
    const ref = findInEarlierSteps(value, earlier);
    if (ref !== null) {
      return ref.path === ""
        ? `{{steps.${ref.id}.${ref.field}}}`
        : `{{steps.${ref.id}.${ref.field}.${ref.path}}}`;
    }
    return value;
  };

  for (let index = 0; index < kept.length;) {
    // rule 9: the same tool called once per item of an earlier list → foreach
    const loop = detectLoop(kept, index, earlier);
    if (loop) {
      const loopId = newId();
      const calls = kept.slice(index, index + loop.count);
      const first = calls[0]!;
      const args: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(first.args)) {
        const itemPath = loop.itemArgs.get(key);
        args[key] =
          itemPath === undefined
            ? templateValue(value)
            : `{{${[loop.as, ...itemPath].join(".")}}}`;
      }
      const results = calls.map((c) => c.result);
      const sideEffect = isSideEffect(first.tool);
      steps.push({
        id: loopId,
        type: "foreach",
        over: `{{steps.${loop.source.id}.result${loop.source.path.length > 0 ? `.${loop.source.path.join(".")}` : ""}}}`,
        as: loop.as,
        body: [
          {
            id: `${loopId}.1`,
            type: "tool",
            tool: first.tool,
            args,
            sideEffect,
            // per item: only what every recorded iteration had
            guard: { schema: inferCommonSchema(results) },
            ...(loop.when ? { when: loop.when } : {}),
          },
        ],
        maxItems: DEFAULT_MAX_ITEMS,
      });
      earlier.push({ id: loopId, field: "results", result: results });
      if (!sideEffect) {
        readOnlyResults.push({
          id: loopId,
          field: "results",
          tool: first.tool,
          result: results,
        });
      }
      index += loop.count;
      continue;
    }

    const call = kept[index++]!;
    const sideEffect = isSideEffect(call.tool);

    const args: Record<string, unknown> = {};
    const llmStepsForTool: WorkflowStep[] = [];

    for (const [key, value] of Object.entries(call.args)) {
      const templated = templateValue(value);
      if (templated !== value) {
        args[key] = templated;
        continue;
      }

      if (typeof value === "string" && isLlmWrittenText(value)) {
        // rule 4: generated text → insert an llm step just before this one
        const llmId = newId();
        const prompt = buildPrompt(
          trace.meta.task,
          readOnlyResults,
          key,
          call.tool,
          constantSiblings(call.args, key),
        );
        // rule 10: lines that are one row per item of a list are written by
        // code at run time; the model writes the rest
        const layout = inferLayout(value, readOnlyResults);
        llmStepsForTool.push({
          id: llmId,
          type: "llm",
          model: "cheap",
          prompt,
          example: value,
          ...(layout ? { layout } : {}),
          // a replay on the recorded data asks exactly this: answer known
          inputKey: answerKey(
            value,
            String(renderTemplate(prompt, recordedContext(trace, earlier))),
          ),
          guard: {
            nonEmpty: true,
            maxChars: Math.max(3 * value.length, 500),
            ...(recordedItemCount(readOnlyResults) > 0
              ? { recordedItems: recordedItemCount(readOnlyResults) }
              : {}),
            // rule 8: values from earlier results that the example mentions
            grounding: collectGrounding(value, readOnlyResults),
            exampleFacts: collectExampleFacts(value, readOnlyResults),
          },
        });
        args[key] = `{{steps.${llmId}.output}}`;
        continue;
      }

      // rule 5: constant
      args[key] = value;
    }

    const toolId = newId();
    steps.push(...llmStepsForTool);

    steps.push({
      id: toolId,
      type: "tool",
      tool: call.tool,
      args,
      sideEffect,
      // rule 7: JSON schema inferred from the recorded result
      guard: { schema: inferSchema(call.result) },
      ...(paginate.has(call) ? { paginate: paginate.get(call) } : {}),
    });

    earlier.push({ id: toolId, field: "result", result: call.result });
    if (!sideEffect)
      readOnlyResults.push({
        id: toolId,
        field: "result",
        tool: call.tool,
        result: call.result,
      });
  }

  const workflow: Workflow = {
    version: 1,
    task: trace.meta.task,
    compiledFrom,
    server: trace.meta.server,
    ...(trace.meta.serverArgv ? { serverArgv: trace.meta.serverArgv } : {}),
    ...(trace.meta.cwd ? { cwd: trace.meta.cwd } : {}),
    inputs: Object.fromEntries(
      inputEntries.map(([name, value]) => [
        name,
        { type: typeof value, example: value },
      ]),
    ),
    steps,
    ...(dropped.length > 0 ? { droppedCalls: dropped } : {}),
  };
  return { workflow, recorded: earlier };
}

interface LoopMatch {
  count: number;
  source: { id: string; path: string[] };
  as: string;
  /** varying argument → path inside the item it equals ([] = the item itself) */
  itemArgs: Map<string, string[]>;
  /** the loop acted on only some items: the rule on the item that picks them */
  when?: Condition;
}

/** Every array inside `node` (length ≥ 2), with its path. */
function arraysIn(
  node: unknown,
  path: string[] = [],
): Array<{ path: string[]; items: unknown[] }> {
  const found: Array<{ path: string[]; items: unknown[] }> = [];
  if (Array.isArray(node)) {
    if (node.length >= 2) found.push({ path, items: node });
    node.forEach((v, i) => found.push(...arraysIn(v, [...path, String(i)])));
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      found.push(...arraysIn(v, [...path, k]));
    }
  }
  return found;
}

/** All paths in `node` whose value equals `value`. */
function pathsOf(
  node: unknown,
  value: unknown,
  path: string[] = [],
): string[][] {
  if (deepEqual(node, value)) return [path];
  const found: string[][] = [];
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      found.push(...pathsOf(v, value, [...path, k]));
    }
  }
  return found;
}

function walk(node: unknown, path: string[]): unknown {
  let value = node;
  for (const p of path) {
    value =
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)[p]
        : undefined;
  }
  return value;
}

// "emails" → "email"; anything unclear → "item"
function loopVariable(path: string[]): string {
  const last = path.filter((p) => !/^\d+$/.test(p)).at(-1) ?? "";
  const singular = last.endsWith("ies")
    ? `${last.slice(0, -3)}y`
    : last.endsWith("s")
      ? last.slice(0, -1)
      : "";
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(singular) &&
    !["inputs", "steps", ""].includes(singular)
    ? singular
    : "item";
}

/**
 * rule 9: calls[index…] are a loop when the same tool is called once per item
 * of an earlier list, in order, covering every item, and every argument that
 * changes between calls equals (a field of) the current item. Anything less
 * certain stays as plain steps: the compiler never guesses.
 */
function detectLoop(
  calls: TraceFile["calls"],
  index: number,
  earlier: Earlier[],
): LoopMatch | null {
  const tool = calls[index]!.tool;
  let runEnd = index;
  while (runEnd < calls.length && calls[runEnd]!.tool === tool) runEnd++;
  const runLength = runEnd - index;
  if (runLength < 2) return null;

  for (const source of earlier) {
    if (source.field !== "result") continue;
    for (const list of arraysIn(source.result)) {
      const n = list.items.length;
      if (n > runLength) continue;
      const window = calls.slice(index, index + n);
      const keys = Object.keys(window[0]!.args).sort().join("\0");
      if (window.some((c) => Object.keys(c.args).sort().join("\0") !== keys)) {
        continue;
      }
      const varying = Object.keys(window[0]!.args).filter((k) =>
        window.some((c) => !deepEqual(c.args[k], window[0]!.args[k])),
      );
      if (varying.length === 0) continue;
      const itemArgs = new Map<string, string[]>();
      for (const key of varying) {
        const candidates = pathsOf(list.items[0], window[0]!.args[key]);
        const path = candidates.find((p) =>
          window.every((c, i) =>
            deepEqual(c.args[key], walk(list.items[i], p)),
          ),
        );
        if (!path) break;
        itemArgs.set(key, path);
      }
      if (itemArgs.size !== varying.length) continue;
      return {
        count: n,
        source: { id: source.id, path: list.path },
        as: loopVariable(list.path),
        itemArgs,
      };
    }
  }
  return detectItemSubsetLoop(calls, index, runLength, earlier);
}

/**
 * "For each email, archive only the spam": the tool was called for some items
 * of a list, in order, and one rule on the item (a field's value, or whether
 * a list field is empty) is true for the items it acted on and false for the
 * rest. No rule, no loop: the calls stay plain steps.
 */
function detectItemSubsetLoop(
  calls: TraceFile["calls"],
  index: number,
  runLength: number,
  earlier: Earlier[],
): LoopMatch | null {
  const window = calls.slice(index, index + runLength);
  const keys = Object.keys(window[0]!.args).sort().join(" ");
  if (window.some((c) => Object.keys(c.args).sort().join(" ") !== keys)) {
    return null;
  }
  const varying = Object.keys(window[0]!.args).filter((k) =>
    window.some((c) => !deepEqual(c.args[k], window[0]!.args[k])),
  );
  if (varying.length === 0) return null;
  for (const source of earlier) {
    if (source.field !== "result") continue;
    for (const list of arraysIn(source.result)) {
      const items = list.items;
      if (items.length <= runLength) continue; // covering every item: the plain loop
      // the item field the first varying argument comes from, and which items
      const first = varying[0]!;
      const paths = new Set<string>();
      for (const item of items) {
        for (const p of pathsOf(item, window[0]!.args[first])) {
          paths.add(JSON.stringify(p));
        }
      }
      for (const raw of paths) {
        const path = JSON.parse(raw) as string[];
        const chosen: number[] = [];
        let at = 0;
        for (const c of window) {
          while (
            at < items.length &&
            !deepEqual(walk(items[at], path), c.args[first])
          ) {
            at++;
          }
          if (at === items.length) break;
          chosen.push(at++);
        }
        if (chosen.length !== window.length) continue;
        const itemArgs = new Map<string, string[]>([[first, path]]);
        for (const key of varying.slice(1)) {
          const p = pathsOf(items[chosen[0]!], window[0]!.args[key]).find((q) =>
            chosen.every((ix, i) =>
              deepEqual(walk(items[ix], q), window[i]!.args[key]),
            ),
          );
          if (p) itemArgs.set(key, p);
        }
        if (itemArgs.size !== varying.length) continue;
        const as = loopVariable(list.path);
        const acted = new Set(chosen);
        const yes: Array<Map<string, Feature>> = [];
        const no: Array<Map<string, Feature>> = [];
        items.forEach((item, ix) => {
          const map = new Map<string, Feature>();
          features(item, as, map);
          (acted.has(ix) ? yes : no).push(map);
        });
        const when = learnRule(yes, no);
        if (!when) continue;
        return {
          count: runLength,
          source: { id: source.id, path: list.path },
          as,
          itemArgs,
          when,
        };
      }
    }
  }
  return null;
}

/** Like inferSchema, but only keeps what every value has (loop iterations differ). */
export function inferCommonSchema(values: unknown[]): Record<string, unknown> {
  if (values.length === 0) return {};
  if (values.every(Array.isArray)) {
    return { type: "array", items: inferCommonSchema(values.flat()) };
  }
  if (
    values.every(
      (v) => v !== null && typeof v === "object" && !Array.isArray(v),
    )
  ) {
    const objects = values as Array<Record<string, unknown>>;
    const keys = Object.keys(objects[0]!).filter((k) =>
      objects.every((o) => Object.hasOwn(o, k)),
    );
    return {
      type: "object",
      properties: Object.fromEntries(
        keys.map((k) => [k, inferCommonSchema(objects.map((o) => o[k]))]),
      ),
      required: keys,
    };
  }
  const types = new Set(values.map((v) => (v === null ? "null" : typeof v)));
  return types.size === 1 ? { type: [...types][0] } : {};
}

// rule 8 (grounding): which values from earlier read-only results does the
// recorded example output mention? At run time the output must mention what
// the same paths hold *now*. Trivial values (short strings, single digits)
// would match by accident, so they are skipped.
const GROUNDING_MIN_STRING = 4;

function isGroundable(value: unknown): value is string | number {
  if (typeof value === "string") {
    return value.trim().length >= GROUNDING_MIN_STRING;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return !Number.isInteger(value) || Math.abs(value) >= 10;
  }
  return false;
}

export function collectGrounding(
  example: string,
  results: Array<{ id: string; result: unknown; field?: "result" | "results" }>,
): GroundingEntry[] {
  const general = generalizeListFields(
    withoutCovered(mentionedValues(example, results), example),
    results,
  );
  // HOTPATH_RELAX_GROUNDING=0 keeps the old per-position entries (to measure the difference)
  if (process.env.HOTPATH_RELAX_GROUNDING === "0") return general;
  const relaxed = relaxPositional(general);
  // HOTPATH_SELECTION_RULES=0: positions only, as before (to measure the difference)
  return process.env.HOTPATH_SELECTION_RULES === "0"
    ? relaxed
    : withSelectionRules(relaxed, results, example);
}

/**
 * Drops a string the example mentions only inside a longer mentioned value:
 * the label "performance" inside the title "Nightly job performance" was
 * never written for itself. Required on new data, it rejected correct texts
 * that listed today's titles but no labels (weekly-report, measured 2026-11-18).
 * The longer value stays required, so leaving it out is still caught.
 */
export function withoutCovered(
  entries: GroundingEntry[],
  example: string,
): GroundingEntry[] {
  const text = normalizeText(example);
  const occurrences = (s: string): number[] => {
    const out: number[] = [];
    for (let at = text.indexOf(s); at >= 0; at = text.indexOf(s, at + 1)) {
      out.push(at);
    }
    return out;
  };
  const strings = entries
    .filter((e) => typeof e.value === "string")
    .map((e) => normalizeText(String(e.value)));
  const spans = strings.flatMap((s) =>
    occurrences(s).map((at) => ({ s, at, end: at + s.length })),
  );
  return entries.filter((e) => {
    if (typeof e.value !== "string") return true;
    const v = normalizeText(e.value);
    const own = occurrences(v);
    return (
      own.length === 0 ||
      !own.every((at) =>
        spans.some(
          (sp) =>
            sp.s.length > v.length && sp.at <= at && at + v.length <= sp.end,
        ),
      )
    );
  });
}

/**
 * Every value from earlier results the example mentions, item by item (not
 * generalized). The runtime rejects an output that repeats one of them once it
 * is no longer in the data: the replay model copied it from the example.
 */
export function collectExampleFacts(
  example: string,
  results: Array<{ id: string; result: unknown; field?: "result" | "results" }>,
): Array<string | number> {
  return mentionedValues(example, results).map((e) => e.value);
}

function mentionedValues(
  example: string,
  results: Array<{ id: string; result: unknown; field?: "result" | "results" }>,
): GroundingEntry[] {
  const byValue = new Map<string, GroundingEntry>();
  const visit = (
    id: string,
    field: string,
    node: unknown,
    segments: string[],
  ) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(id, field, v, [...segments, String(i)]));
    } else if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        visit(id, field, v, [...segments, k]);
      }
    } else if (isGroundable(node) && mentions(example, node)) {
      const ref = ["steps", id, field, ...segments].join(".");
      const key = `${typeof node}:${node}`;
      const entry = byValue.get(key);
      if (entry) entry.paths.push(ref);
      else byValue.set(key, { value: node, paths: [ref] });
    }
  };
  for (const { id, result, field } of results) {
    visit(id, field ?? "result", result, []);
  }
  return [...byValue.values()];
}

/**
 * When the example mentions a field for at least half the items of a list
 * (2 of 3 email subjects), require it for every item: the paths become one
 * `…emails.*.subject` path that the runtime expands against the current data.
 * Small agents skip an item now and then, and the next day's list can be
 * longer; per-index paths would check neither.
 */
function generalizeListFields(
  entries: GroundingEntry[],
  results: Array<{ id: string; result: unknown; field?: "result" | "results" }>,
): GroundingEntry[] {
  // the innermost list index splits a path into list prefix and item field
  const split = (ref: string) => {
    const parts = ref.split(".");
    for (let i = parts.length - 1; i >= 3; i--) {
      if (/^\d+$/.test(parts[i])) {
        return {
          prefix: parts.slice(0, i).join("."),
          index: Number(parts[i]),
          rel: parts.slice(i + 1).join("."),
        };
      }
    }
    return null;
  };
  const listLength = (prefix: string): number => {
    const [, id, field, ...rest] = prefix.split(".");
    const source = results.find(
      (r) => r.id === id && (r.field ?? "result") === field,
    );
    let node: unknown = source?.result;
    for (const key of rest) {
      node =
        node !== null && typeof node === "object"
          ? (node as Record<string, unknown>)[key]
          : undefined;
    }
    return Array.isArray(node) ? node.length : 0;
  };

  const groups = new Map<
    string,
    { indices: Set<number>; value: string | number }
  >();
  for (const entry of entries) {
    for (const ref of entry.paths) {
      const s = split(ref);
      if (!s) continue;
      const key = `${s.prefix}\u0000${s.rel}`;
      const group = groups.get(key) ?? {
        indices: new Set(),
        value: entry.value,
      };
      group.indices.add(s.index);
      groups.set(key, group);
    }
  }
  const general = new Map<string, string | number>();
  for (const [key, group] of groups) {
    const prefix = key.split("\u0000")[0];
    const n = listLength(prefix);
    // at least two items: one match can be a coincidence ("14:00" in an email
    // subject is also an event's start time)
    if (n >= 2 && group.indices.size >= Math.max(2, Math.ceil(n / 2))) {
      general.set(key, group.value);
    }
  }
  // The same list read in several steps (open issues of each repo): judged
  // together. Measured on weekly-report: the agent named 5 of 5 issues, but
  // web-app had one, so its list was never generalized and a replay that left
  // out a new issue there passed the number check.
  const shape = (key: string) =>
    key.replace(/^steps\.[^.]+\.(results?)\./, "steps.<step>.$1.");
  const shapes = new Map<
    string,
    { mentioned: number; items: number; keys: string[] }
  >();
  for (const [key, group] of groups) {
    const s = shapes.get(shape(key)) ?? { mentioned: 0, items: 0, keys: [] };
    s.mentioned += group.indices.size;
    s.items += listLength(key.split("\u0000")[0]);
    s.keys.push(key);
    shapes.set(shape(key), s);
  }
  for (const s of shapes.values()) {
    if (
      s.keys.length >= 2 &&
      s.items >= 2 &&
      s.mentioned >= Math.max(2, Math.ceil(s.items / 2))
    ) {
      for (const key of s.keys) general.set(key, groups.get(key)!.value);
    }
  }
  if (general.size === 0) return entries;

  const out: GroundingEntry[] = [];
  const emitted = new Set<string>();
  for (const entry of entries) {
    const kept: string[] = [];
    for (const ref of entry.paths) {
      const s = split(ref);
      const key = s ? `${s.prefix}\u0000${s.rel}` : "";
      if (!s || !general.has(key)) {
        kept.push(ref);
        continue;
      }
      if (!emitted.has(key)) {
        emitted.add(key);
        const wildcard = s.rel ? `${s.prefix}.*.${s.rel}` : `${s.prefix}.*`;
        out.push({ value: general.get(key)!, paths: [wildcard] });
      }
    }
    if (kept.length > 0) out.push({ value: entry.value, paths: kept });
  }
  return out;
}

/** Errored calls (tool errors and MCP protocol errors) are set aside. */
function splitFailedCalls(trace: TraceFile): {
  kept: TraceFile["calls"];
  dropped: DroppedCall[];
} {
  const kept: TraceFile["calls"] = [];
  const dropped: DroppedCall[] = [];
  trace.calls.forEach((call, i) => {
    if (!call.isError) {
      kept.push(call);
      return;
    }
    const retried = trace.calls
      .slice(i + 1)
      .some((later) => later.tool === call.tool && !later.isError);
    dropped.push({
      seq: call.seq,
      line: i + 2, // trace file: meta is line 1, then the calls in order
      tool: call.tool,
      reason: retried ? "retried" : "failed",
      error: errorPreview(call.result),
    });
  });
  return { kept, dropped };
}

function errorPreview(result: unknown): string | undefined {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  if (!text) return undefined;
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function isLlmWrittenText(value: string): boolean {
  return value.length >= LLM_TEXT_MIN_CHARS || value.includes("\n");
}

/** The template context a replay of the recorded run builds. */
function recordedContext(trace: TraceFile, earlier: Earlier[]) {
  const steps: Record<string, { result?: unknown; results?: unknown[] }> = {};
  for (const { id, field, result } of earlier) {
    steps[id] =
      field === "results" ? { results: result as unknown[] } : { result };
  }
  return { inputs: trace.meta.inputs, steps };
}

function buildPrompt(
  task: string,
  readOnlyResults: ReadOnlyResult[],
  argName: string,
  tool: string,
  siblings: string,
): string {
  const parts = [`You are compiling the task "${task}".`];
  // Templates, not recorded data: the runtime fills them with each run's results.
  for (const { id, tool: toolName, field } of readOnlyResults) {
    const label = field === "results" ? `results (one per item)` : "result";
    parts.push(`${id} ${toolName} ${label}:\n{{steps.${id}.${field}}}`);
  }
  parts.push(
    `write the \`${argName}\` for \`${tool}\`${siblings}. Use only the data above and cover every item in it.`,
  );
  return parts.join("\n\n");
}

// ` (to="manager")`: the short constant args next to the generated one.
function constantSiblings(args: Record<string, unknown>, skip: string): string {
  const parts = Object.entries(args)
    .filter(
      ([k, v]) => k !== skip && typeof v === "string" && !isLlmWrittenText(v),
    )
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

// rule 3: find `value` inside an earlier result; returns the shortest path.
function findInEarlierSteps(
  value: unknown,
  earlier: Earlier[],
): { id: string; field: Earlier["field"]; path: string } | null {
  for (const { id, field, result } of earlier) {
    const path = findPath(result, value, []);
    if (path !== null) return { id, field, path: path.join(".") };
  }
  return null;
}

function findPath(
  node: unknown,
  value: unknown,
  path: string[],
): string[] | null {
  if (deepEqual(node, value)) return path;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const found = findPath(node[i], value, [...path, String(i)]);
      if (found !== null) return found;
    }
    return null;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const found = findPath(v, value, [...path, k]);
      if (found !== null) return found;
    }
  }
  return null;
}

// rule 7: object keys observed = required; primitive types; array items =
// what every recorded item has. (The first item alone made a key that only it
// carried, an attachment say, required for every item of every later run.)
export function inferSchema(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { type: "array", items: inferCommonSchema(value) };
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return {
      type: "object",
      properties: Object.fromEntries(
        entries.map(([k, v]) => [k, inferSchema(v)]),
      ),
      required: entries.map(([k]) => k),
    };
  }
  return { type: value === null ? "null" : typeof value };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
