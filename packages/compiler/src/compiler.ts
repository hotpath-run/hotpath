import {
  answerKey,
  countItems,
  DEFAULT_MAX_ITEMS,
  detailsPerItem,
  mentions,
  normalizeText,
  numbersInText,
  renderTemplate,
  REQUEST_RULE,
  requestInputs,
  type Condition,
  type DroppedCall,
  type GroundingEntry,
  type ItemDecision,
  type ToolStep,
  type TraceFile,
  type Workflow,
  type WorkflowStep,
} from "@hotpathrun/shared";
import {
  features,
  learnItemRule,
  learnItemThresholdRule,
  type Feature,
} from "./rules.js";

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

/**
 * What other recordings of the task taught: facts one recording alone cannot
 * show. compileTraces compares recordings, then compiles each again with this.
 */
export interface CompileHints {
  /** `tool\0argument`: written by the model although short (it differed between recordings) */
  textArgs?: ReadonlySet<string>;
  /** tools another recording called once per item: a run of 1 call is a loop too */
  loopTools?: ReadonlySet<string>;
  /** tool → the rule on a list item that picked the items it acted on, learned from all recordings together */
  itemRules?: ReadonlyMap<string, Condition>;
  /** filled while compiling: per tool, the items of the lists it acted on (yes) or passed over (no) */
  samples?: Map<string, ItemSamples>;
  /** filled while compiling: the list a looping tool goes through (read again to see what a run that skipped the tool had) */
  sources?: Map<string, ListSource>;
}

export interface ListSource {
  /** the tool whose result holds the list */
  tool: string;
  path: string[];
  as: string;
}

export interface ItemSamples {
  yes: Array<Map<string, Feature>>;
  no: Array<Map<string, Feature>>;
}

/** Whether a learned item rule gives the verdict a recording shows (rules from `learnItemRule`). */
function ruleHolds(
  rule: Condition,
  yes: Array<Map<string, Feature>>,
  no: Array<Map<string, Feature>>,
): boolean {
  if (rule.kind !== "equals" && rule.kind !== "notEquals") return false;
  const test = (m: Map<string, Feature>) => {
    const f = m.get(rule.ref);
    if (!f || !("scalar" in f)) return null;
    return rule.kind === "equals"
      ? f.scalar === rule.value
      : f.scalar !== rule.value;
  };
  return (
    yes.every((m) => test(m) === true) && no.every((m) => test(m) === false)
  );
}

/** The items of `items` as feature maps, split by whether the tool acted on them. */
function sampleItems(
  items: unknown[],
  as: string,
  acted: ReadonlySet<number>,
): ItemSamples {
  const out: ItemSamples = { yes: [], no: [] };
  items.forEach((item, ix) => {
    const map = new Map<string, Feature>();
    features(item, as, map);
    (acted.has(ix) ? out.yes : out.no).push(map);
  });
  return out;
}

function addSamples(hints: CompileHints, tool: string, got: ItemSamples): void {
  if (!hints.samples) return;
  const have = hints.samples.get(tool) ?? { yes: [], no: [] };
  have.yes.push(...got.yes);
  have.no.push(...got.no);
  hints.samples.set(tool, have);
}

export const textArgKey = (tool: string, arg: string) => `${tool}\0${arg}`;

/** compileTrace, plus each step's recorded result (branch learning compares them). */
export function compileTraceDetailed(
  trace: TraceFile,
  compiledFrom: string,
  hints: CompileHints = {},
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

  // what a rule on items may be grounded in: numbers the agent wrote that no
  // data holds ("over 10,000 EUR") and the run's date inputs
  const facts: ItemFacts = {
    written: kept.flatMap((c) =>
      Object.values(c.args)
        .filter((v): v is string => typeof v === "string")
        .flatMap((v) => numbersInText(v)),
    ),
    dataValues: new Set<number>(),
    inputs: trace.meta.inputs,
  };
  const collectNumbers = (v: unknown): void => {
    if (typeof v === "number") facts.dataValues.add(v);
    else if (Array.isArray(v)) v.forEach(collectNumbers);
    else if (v !== null && typeof v === "object")
      Object.values(v).forEach(collectNumbers);
  };
  for (const c of kept) collectNumbers(c.result);

  for (let index = 0; index < kept.length;) {
    // rule 9: the same tool called once per item of an earlier list → foreach
    const loop = detectLoop(
      kept,
      index,
      earlier,
      hints,
      !isSideEffect(kept[index]!.tool),
      facts,
    );
    if (loop) {
      const loopId = newId();
      const calls = kept.slice(index, index + loop.count);
      const first = calls[0]!;
      const listTool = readOnlyResults.find(
        (r) => r.id === loop.source.id,
      )?.tool;
      if (listTool) {
        hints.sources?.set(first.tool, {
          tool: listTool,
          path: loop.source.path,
          as: loop.as,
        });
      }
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
        ...(loop.distinct ? { distinct: loop.distinct } : {}),
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

    // rule 12: actions on the items of a list, chosen per item → a loop whose
    // replay model decides each item's action before any action runs
    const decision = detectDecisionLoop(kept, index, earlier, isSideEffect);
    if (decision) {
      const loopId = newId();
      const built = buildDecisionLoop(decision, loopId, {
        task: trace.meta.task,
        request: requestInputs(trace.meta.inputs),
        readOnlyResults,
        steps,
        earlier,
        templateValue,
      });
      steps.push(built.step);
      // the loop's results are its decisions: a summary written after it
      // reads which item got what, instead of guessing from the example
      earlier.push({ id: loopId, field: "results", result: built.results });
      readOnlyResults.push({
        id: loopId,
        field: "results",
        tool: `decisions per ${built.as}`,
        result: built.results,
      });
      index += decision.count;
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

      // a value that differs between recordings is never a constant, however short
      if (
        typeof value === "string" &&
        (isLlmWrittenText(value) ||
          hints.textArgs?.has(textArgKey(call.tool, key)) ||
          quotesData(value, sideEffect, readOnlyResults))
      ) {
        // rule 4: generated text → insert an llm step just before this one
        const llmId = newId();
        const prompt = buildPrompt(
          trace.meta.task,
          readOnlyResults,
          key,
          call.tool,
          constantSiblings(call.args, key),
          requestInputs(trace.meta.inputs),
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

  // a recording that never called a tool others loop with: every item of its
  // list was passed over, which is what tells the items that are acted on apart
  for (const [tool, src] of hints.sources ?? []) {
    if (kept.some((c) => c.tool === tool)) continue;
    const list = walk(
      readOnlyResults.find((r) => r.tool === src.tool)?.result,
      src.path,
    );
    if (Array.isArray(list)) {
      addSamples(hints, tool, sampleItems(list, src.as, new Set()));
    }
  }

  const positional = positionalActions(steps);
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
    ...(positional.length > 0 ? { positional } : {}),
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
  /** one call per distinct value at this path in the item */
  distinct?: string[];
}

/** Every array inside `node` (length ≥ `min`, 2 unless a loop is known), with its path. */
function arraysIn(
  node: unknown,
  path: string[] = [],
  min = 2,
): Array<{ path: string[]; items: unknown[] }> {
  const found: Array<{ path: string[]; items: unknown[] }> = [];
  if (Array.isArray(node)) {
    if (node.length >= min) found.push({ path, items: node });
    node.forEach((v, i) =>
      found.push(...arraysIn(v, [...path, String(i)], min)),
    );
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      found.push(...arraysIn(v, [...path, k], min));
    }
  }
  return found;
}

/**
 * The arguments that change from call to call. A run of one call shows no
 * change; when another recording proved the tool is called per item, the
 * arguments that equal a field of the item are the ones that vary.
 */
function varyingArgs(
  window: TraceFile["calls"],
  items: unknown[] | null,
): string[] {
  if (window.length === 1 && items) {
    return Object.keys(window[0]!.args).filter((k) =>
      items.some((item) => pathsOf(item, window[0]!.args[k]).length > 0),
    );
  }
  return Object.keys(window[0]!.args).filter((k) =>
    window.some((c) => !deepEqual(c.args[k], window[0]!.args[k])),
  );
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
  hints: CompileHints,
  readOnly = false,
  facts?: ItemFacts,
): LoopMatch | null {
  const tool = calls[index]!.tool;
  const known = hints.loopTools?.has(tool) === true;
  let runEnd = index;
  while (runEnd < calls.length && calls[runEnd]!.tool === tool) runEnd++;
  const runLength = runEnd - index;
  if (runLength < (known ? 1 : 2)) {
    return runLength === 1 && !readOnly && facts
      ? detectSingleItemLoop(calls[index]!, earlier, facts)
      : null;
  }

  for (const source of earlier) {
    if (source.field !== "result") continue;
    for (const list of arraysIn(source.result, [], known ? 1 : 2)) {
      const n = list.items.length;
      if (n > runLength) continue;
      const window = calls.slice(index, index + n);
      const keys = Object.keys(window[0]!.args).sort().join("\0");
      if (window.some((c) => Object.keys(c.args).sort().join("\0") !== keys)) {
        continue;
      }
      const varying = varyingArgs(window, known ? list.items : null);
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
      const as = loopVariable(list.path);
      // every item was acted on here; another recording that skipped some
      // items says which ones, and that rule holds for this one too
      const got = sampleItems(list.items, as, new Set(list.items.keys()));
      addSamples(hints, tool, got);
      const rule = hints.itemRules?.get(tool);
      return {
        count: n,
        source: { id: source.id, path: list.path },
        as,
        itemArgs,
        ...(rule && ruleHolds(rule, got.yes, got.no) ? { when: rule } : {}),
      };
    }
  }
  return (
    detectDistinctLoop(calls, index, runLength, earlier, readOnly) ??
    detectItemSubsetLoop(calls, index, runLength, earlier, hints) ??
    // a tool another pass already looped is "known" and skips the early exit
    (runLength === 1 && !readOnly && facts
      ? detectSingleItemLoop(calls[index]!, earlier, facts)
      : null)
  );
}

interface ItemFacts {
  written: number[];
  dataValues: Set<number>;
  inputs: Record<string, unknown>;
}

/**
 * "Flag every overdue invoice over 10,000" on a day only one qualified: one
 * action on one item of a list. It becomes a loop over the list only when a rule
 * grounded in what the agent wrote and the run's dates tells that item apart
 * from every other one; otherwise the call stays a plain step (it was).
 */
function detectSingleItemLoop(
  call: TraceFile["calls"][number],
  earlier: Earlier[],
  facts: ItemFacts,
): LoopMatch | null {
  const unique = (items: unknown[], path: string[], value: unknown) =>
    items.filter((it) => deepEqual(walk(it, path), value)).length === 1;
  for (const source of earlier) {
    if (source.field !== "result") continue;
    for (const list of arraysIn(source.result, [], 2)) {
      const items = list.items;
      for (const [key, value] of Object.entries(call.args)) {
        if (typeof value !== "string" && typeof value !== "number") continue;
        const ix = items.findIndex((it) => pathsOf(it, value).length > 0);
        if (ix < 0) continue;
        const path = pathsOf(items[ix], value).find((p) =>
          unique(items, p, value),
        );
        if (!path) continue;
        const itemArgs = new Map<string, string[]>([[key, path]]);
        for (const [other, v] of Object.entries(call.args)) {
          if (other === key) continue;
          const p = pathsOf(items[ix], v)[0];
          if (p) itemArgs.set(other, p);
        }
        const as = loopVariable(list.path);
        const { yes, no } = sampleItems(items, as, new Set([ix]));
        const when = learnItemThresholdRule(
          yes,
          no,
          facts.written,
          facts.dataValues,
          facts.inputs,
        );
        if (!when) continue;
        return {
          count: 1,
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

/**
 * "Check the stock of each product the orders need": one call per distinct
 * value of an item field, in the order the values first appear, covering every
 * distinct value. Without it the calls stay plain steps pointing at orders 0, 1,
 * 2 by position, which a new day's orders don't match.
 */
function detectDistinctLoop(
  calls: TraceFile["calls"],
  index: number,
  runLength: number,
  earlier: Earlier[],
  readOnly: boolean,
): LoopMatch | null {
  if (runLength < 2) return null;
  const window = calls.slice(index, index + runLength);
  const keys = Object.keys(window[0]!.args).sort().join("\0");
  if (window.some((c) => Object.keys(c.args).sort().join("\0") !== keys))
    return null;
  const varying = varyingArgs(window, null);
  if (varying.length !== 1) return null;
  const key = varying[0]!;
  for (const source of earlier) {
    if (source.field !== "result") continue;
    for (const list of arraysIn(source.result, [], 2)) {
      const candidates = new Set<string>();
      for (const item of list.items) {
        for (const p of pathsOf(item, window[0]!.args[key])) {
          if (p.length > 0) candidates.add(JSON.stringify(p));
        }
      }
      for (const raw of candidates) {
        const path = JSON.parse(raw) as string[];
        const firsts: unknown[] = [];
        for (const item of list.items) {
          const v = walk(item, path);
          if (!firsts.some((f) => deepEqual(f, v))) firsts.push(v);
        }
        const ordered =
          firsts.length < list.items.length &&
          firsts.length === window.length &&
          window.every((c, i) => deepEqual(c.args[key], firsts[i]));
        // a lookup only reads: the order it ran in and a repeated call don't
        // matter, only that every distinct value was looked up
        const sameValues =
          readOnly &&
          window.every((c) => firsts.some((f) => deepEqual(f, c.args[key]))) &&
          firsts.every((f) => window.some((c) => deepEqual(c.args[key], f)));
        if (!ordered && !sameValues) continue;
        return {
          count: runLength,
          source: { id: source.id, path: list.path },
          as: loopVariable(list.path),
          itemArgs: new Map([[key, path]]),
          distinct: path,
        };
      }
    }
  }
  return null;
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
  hints: CompileHints,
): LoopMatch | null {
  const known = hints.loopTools?.has(calls[index]!.tool) === true;
  const window = calls.slice(index, index + runLength);
  const keys = Object.keys(window[0]!.args).sort().join(" ");
  if (window.some((c) => Object.keys(c.args).sort().join(" ") !== keys)) {
    return null;
  }
  const sourceLists = (source: Earlier) =>
    source.field === "result" ? arraysIn(source.result, [], known ? 1 : 2) : [];
  const varying = varyingArgs(
    window,
    known
      ? earlier.flatMap((e) => sourceLists(e)).flatMap((l) => l.items)
      : null,
  );
  if (varying.length === 0) return null;
  for (const source of earlier) {
    if (source.field !== "result") continue;
    for (const list of sourceLists(source)) {
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
        const { yes, no } = sampleItems(items, as, acted);
        addSamples(hints, calls[index]!.tool, { yes, no });
        const pooled = hints.itemRules?.get(calls[index]!.tool);
        const when =
          pooled && ruleHolds(pooled, yes, no)
            ? pooled
            : learnItemRule(yes, no);
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
  if (types.size === 1) return { type: [...types][0] };
  // a value that is sometimes null (a parcel not delivered yet): both types
  // are allowed, not "must be null" because one sample happened to be
  if (types.size === 2 && types.has("null")) {
    const other = [...types].find((t) => t !== "null")!;
    if (other === "string" || other === "number" || other === "boolean") {
      return { type: [other, "null"] };
    }
  }
  return {};
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

/**
 * What an action sends is written text, even when short, if it quotes a long
 * value of what was just read ("New today: Q3 budget review"): the same words
 * tomorrow would be wrong. Short values ("spam", "urgent") label a path, not
 * the day's data, so they do not count.
 */
const QUOTE_MIN_CHARS = 12;
function quotesData(
  value: string,
  sideEffect: boolean,
  results: Array<{ id: string; result: unknown; field?: "result" | "results" }>,
): boolean {
  return (
    sideEffect &&
    /\s/.test(value.trim()) &&
    mentionedValues(value, results).some(
      (e) => typeof e.value === "string" && e.value.length >= QUOTE_MIN_CHARS,
    )
  );
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
  request: string[] = [],
): string {
  const parts = [`You are compiling the task "${task}".`];
  // the person's own words: the text must answer them, in their language
  for (const name of request) {
    parts.push(`the request (inputs.${name}):
{{inputs.${name}}}`);
  }
  // Templates, not recorded data: the runtime fills them with each run's results.
  for (const { id, tool: toolName, field } of readOnlyResults) {
    const label = field === "results" ? `results (one per item)` : "result";
    parts.push(`${id} ${toolName} ${label}:\n{{steps.${id}.${field}}}`);
  }
  parts.push(
    `write the \`${argName}\` for \`${tool}\`${siblings}. Use only the data above and cover every item in it.${request.length > 0 ? ` ${REQUEST_RULE}` : ""}`,
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

// ── rule 12: per-item decisions ───────────────────────────────────────

interface DecisionMatch {
  /** calls consumed from the trace */
  count: number;
  source: { id: string; path: string[] };
  items: unknown[];
  /** the path in an item that names it, unique across the list ("id") */
  keyPath: string[];
  /** item index → the action the agent took on it */
  acted: Map<number, TraceFile["calls"][number]>;
  /** tool → the argument that carries the item's key */
  keyArg: Map<string, string>;
}

const CHOICE = "choice";
const MAX_DECISION_EXAMPLES = 20;

/**
 * rule 12: calls[index…] are actions, one per item of an earlier list, in the
 * list's order, each naming its item by a key unique in the list (its id), and
 * the tool or the other values change from item to item (rule 9 found no loop:
 * the agent decided per item). Two actions at least; anything less certain
 * stays plain steps.
 */
function detectDecisionLoop(
  calls: TraceFile["calls"],
  index: number,
  earlier: Earlier[],
  isSideEffect: (tool: string) => boolean,
): DecisionMatch | null {
  const first = calls[index]!;
  if (!isSideEffect(first.tool)) return null;
  for (const source of earlier) {
    if (source.field !== "result") continue;
    for (const list of arraysIn(source.result, [], 2)) {
      for (const [argName, value] of Object.entries(first.args)) {
        if (typeof value !== "string" && typeof value !== "number") continue;
        for (const [start, item] of list.items.entries()) {
          for (const keyPath of pathsOf(item, value)) {
            if (keyPath.length === 0) continue;
            const keys = list.items.map((it) =>
              JSON.stringify(walk(it, keyPath)),
            );
            if (new Set(keys).size !== keys.length) continue;
            const run = extendDecisionRun(
              calls,
              index,
              list.items,
              keyPath,
              start,
              argName,
              isSideEffect,
            );
            if (run.acted.size >= 2) {
              return {
                ...run,
                source: { id: source.id, path: list.path },
                items: list.items,
                keyPath,
              };
            }
          }
        }
      }
    }
  }
  return null;
}

function extendDecisionRun(
  calls: TraceFile["calls"],
  index: number,
  items: unknown[],
  keyPath: string[],
  start: number,
  firstArg: string,
  isSideEffect: (tool: string) => boolean,
): Pick<DecisionMatch, "count" | "acted" | "keyArg"> {
  const acted = new Map([[start, calls[index]!]]);
  const keyArg = new Map([[calls[index]!.tool, firstArg]]);
  let last = start;
  let j = index + 1;
  for (; j < calls.length && isSideEffect(calls[j]!.tool); j++) {
    const c = calls[j]!;
    const names = keyArg.has(c.tool)
      ? [keyArg.get(c.tool)!]
      : Object.keys(c.args);
    let found: { arg: string; at: number } | null = null;
    for (const arg of names) {
      for (let m = last + 1; m < items.length && !found; m++) {
        if (deepEqual(walk(items[m], keyPath), c.args[arg]))
          found = { arg, at: m };
      }
      if (found) break;
    }
    if (!found) break;
    acted.set(found.at, c);
    keyArg.set(c.tool, found.arg);
    last = found.at;
  }
  return { count: j - index, acted, keyArg };
}

interface DecisionContext {
  task: string;
  request: string[];
  readOnlyResults: ReadOnlyResult[];
  steps: WorkflowStep[];
  earlier: Earlier[];
  templateValue: (value: unknown) => unknown;
}

function buildDecisionLoop(
  match: DecisionMatch,
  loopId: string,
  ctx: DecisionContext,
): { step: WorkflowStep; results: unknown[]; as: string } {
  const overPath =
    match.source.path.length > 0 ? `.${match.source.path.join(".")}` : "";
  const over = `{{steps.${match.source.id}.result${overPath}}}`;
  const named = loopVariable(match.source.path);
  const as = named === CHOICE ? "item" : named;
  const lookup = itemDetails(over, match.items, ctx);
  const detailsOf = lookup.of;
  const byTool = new Map<string, Array<[number, TraceFile["calls"][number]]>>();
  for (const [at, c] of [...match.acted].sort(([a], [b]) => a - b)) {
    byTool.set(c.tool, [...(byTool.get(c.tool) ?? []), [at, c]]);
  }

  const body: ToolStep[] = [];
  const actions: ItemDecision["actions"] = [];
  // item index → the values its action needed
  const chosen = new Map<number, Record<string, unknown>>();
  for (const [tool, done] of byTool) {
    const keyArg = match.keyArg.get(tool)!;
    const args: Record<string, unknown> = {
      [keyArg]: `{{${[as, ...match.keyPath].join(".")}}}`,
    };
    const fields: Record<string, "string" | "number"> = {};
    for (const name of Object.keys(done[0]![1].args)) {
      if (name === keyArg) continue;
      const values = done.map(([, c]) => c.args[name]);
      // the same field of each item: code fills it in
      const inItem = pathsOf(match.items[done[0]![0]], values[0]).find(
        (p) =>
          p.length > 0 &&
          done.every(([at, c]) =>
            deepEqual(walk(match.items[at], p), c.args[name]),
          ),
      );
      if (inItem) {
        args[name] = `{{${[as, ...inItem].join(".")}}}`;
        continue;
      }
      const same = values.every((v) => deepEqual(v, values[0]));
      const fromData =
        ctx.templateValue(values[0]) !== values[0] ||
        done.some(([at]) => pathsOf(detailsOf(at), values[0]).length > 0);
      const primitive = values.every(
        (v) => typeof v === "string" || typeof v === "number",
      );
      if ((same && !fromData) || !primitive) {
        args[name] = values[0]; // a constant, until a recording varies it
        continue;
      }
      fields[name] = values.every((v) => typeof v === "number")
        ? "number"
        : "string";
      args[name] = `{{${CHOICE}.${name}}}`;
      for (const [at, c] of done)
        chosen.set(at, { ...(chosen.get(at) ?? {}), [name]: c.args[name] });
    }
    actions.push({ tool, fields });
    body.push({
      id: `${loopId}.${body.length + 1}`,
      type: "tool",
      tool,
      args,
      sideEffect: true,
      guard: { schema: inferCommonSchema(done.map(([, c]) => c.result)) },
      when: { kind: "equals", ref: `${CHOICE}.action`, value: tool },
    });
  }

  const decide: ItemDecision = {
    model: "cheap",
    prompt: decisionContextPrompt(ctx),
    key: match.keyPath,
    ...(lookup.spec ? { details: lookup.spec } : {}),
    actions,
    examples: decisionExamples(match, detailsOf, chosen),
  };
  return {
    step: {
      id: loopId,
      type: "foreach",
      over,
      as,
      decide,
      body,
      maxItems: DEFAULT_MAX_ITEMS,
    },
    results: match.items.map((item, at) => {
      const c = match.acted.get(at);
      return {
        [match.keyPath.join(".")]: walk(item, match.keyPath),
        action: c ? c.tool : "none",
        ...(chosen.get(at) ?? {}),
      };
    }),
    as,
  };
}

/** The item's own looked-up data: an earlier loop over the same list, one result per item. */
function itemDetails(
  over: string,
  items: unknown[],
  ctx: DecisionContext,
): { of: (at: number) => unknown; spec?: ItemDecision["details"] } {
  const lookup = ctx.steps.find(
    (s): s is Extract<WorkflowStep, { type: "foreach" }> =>
      s.type === "foreach" && s.over === over && !s.decide,
  );
  if (!lookup) return { of: () => undefined };
  const results = ctx.earlier.find(
    (e) => e.id === lookup.id && e.field === "results",
  )?.result;
  const paired = detailsPerItem(items, results, lookup.distinct);
  return {
    of: (at) => paired[at],
    spec: {
      step: lookup.id,
      ...(lookup.distinct ? { distinct: lookup.distinct } : {}),
    },
  };
}

function decisionExamples(
  match: DecisionMatch,
  detailsOf: (at: number) => unknown,
  chosen: Map<number, Record<string, unknown>>,
): ItemDecision["examples"] {
  // every action the agent took first, then items it left alone
  const order = [...match.acted.keys(), ...match.items.keys()].filter(
    (at, i, all) => all.indexOf(at) === i,
  );
  return order
    .slice(0, MAX_DECISION_EXAMPLES)
    .sort((a, b) => a - b)
    .map((at) => {
      const details = detailsOf(at);
      const c = match.acted.get(at);
      return {
        item: compactValue(match.items[at]),
        ...(details !== undefined ? { details: compactValue(details) } : {}),
        choice: c
          ? { action: c.tool, ...(chosen.get(at) ?? {}) }
          : { action: "none" },
      };
    });
}

/** Long strings cut to a few hundred characters: examples show the rule, not the documents. */
function compactValue(value: unknown): unknown {
  if (typeof value === "string")
    return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(compactValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, compactValue(v)]),
    );
  }
  return value;
}

function decisionContextPrompt(ctx: DecisionContext): string {
  const parts = [
    `You are replaying the task "${ctx.task}": deciding what to do with each item of a list.`,
  ];
  for (const name of ctx.request)
    parts.push(`the request (inputs.${name}):\n{{inputs.${name}}}`);
  for (const { id, tool, field } of ctx.readOnlyResults) {
    const label = field === "results" ? "results (one per item)" : "result";
    parts.push(`${id} ${tool} ${label}:\n{{steps.${id}.${field}}}`);
  }
  return parts.join("\n\n");
}

/**
 * Side-effect steps that point at items of one list by position (`leads.0.id`,
 * `leads.1.id`): a new day's list has other items in other places, so a replay
 * would act on the wrong ones. Rule 12 turns the usual case into a loop; what
 * is left is reported, and the runtime never replays it.
 */
export function positionalActions(
  steps: WorkflowStep[],
): NonNullable<Workflow["positional"]> {
  const byList = new Map<string, { steps: string[]; at: Set<string> }>();
  const ref =
    /\{\{(steps\.[\w-]+\.results?(?:\.[\w-]+)*?)\.(\d+)(?:\.[^}]*)?\}\}/g;
  for (const step of steps) {
    if (step.type !== "tool" || !step.sideEffect) continue;
    for (const m of JSON.stringify(step.args).matchAll(ref)) {
      const list = m[1]!;
      const entry = byList.get(list) ?? { steps: [], at: new Set<string>() };
      if (!entry.steps.includes(step.id)) entry.steps.push(step.id);
      entry.at.add(m[2]!);
      byList.set(list, entry);
    }
  }
  return [...byList]
    .filter(([, e]) => e.at.size >= 2 && e.steps.length >= 2)
    .map(([list, e]) => ({ list, steps: e.steps }));
}
