// Count, then compile what is hot: runs are grouped by path signature, and a
// path is hot once its last N runs all finished cleanly. A failed run resets
// the count; it does not ban the path for ever.
import { compileTraces, recordingProblems } from "@hotpathrun/compiler";
import type { TraceFile } from "@hotpathrun/shared";

import { pathSignature } from "./signature.js";

/** How many clean runs in a row make a path hot, unless configured. */
export const DEFAULT_HOT_AFTER = 3;

export interface RunHealth {
  clean: boolean;
  problems: string[];
}

export interface PathGroup {
  id: string;
  key: string;
  steps: string[];
  /** oldest first */
  runs: TraceFile[];
  health: RunHealth[];
  hot: boolean;
  /**
   * Runs after the path first turned hot: a live workflow could have
   * answered them with no agent (the future hit rate).
   */
  servable: number;
}

export interface GroupOptions {
  hotAfter?: number;
}

/**
 * Did the run finish without an error, and does its recording pass the
 * compiler's recording check (no tool error or empty answer it built on)?
 */
export function runHealth(trace: TraceFile): RunHealth {
  const problems: string[] = [];
  if (trace.open)
    problems.push("the run had not finished (the trace is still open)");
  const failed = trace.calls.filter((c) => c.isError);
  if (failed.length > 0) {
    problems.push(
      `${failed.length} tool call${failed.length === 1 ? "" : "s"} failed (${[...new Set(failed.map((c) => c.tool))].join(", ")})`,
    );
  }
  if (trace.calls.length === 0) problems.push("the run made no tool call");
  if (problems.length === 0) {
    try {
      const compiled = compileTraces([trace], "learn");
      problems.push(
        ...recordingProblems(trace, compiled.workflow, compiled.recorded),
      );
    } catch (err) {
      problems.push(
        `it does not compile: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { clean: problems.length === 0, problems };
}

/** Runs grouped by path signature, most runs first; `runs` oldest first. */
export function groupRuns(
  runs: TraceFile[],
  options: GroupOptions = {},
): PathGroup[] {
  const hotAfter = Math.max(1, options.hotAfter ?? DEFAULT_HOT_AFTER);
  const groups = new Map<string, Omit<PathGroup, "hot" | "servable">>();
  for (const run of runs) {
    const sig = pathSignature(run);
    if (sig.calls.length === 0) continue; // nothing to compile
    const group = groups.get(sig.key) ?? {
      id: sig.id,
      key: sig.key,
      steps: sig.steps,
      runs: [],
      health: [],
    };
    group.runs.push(run);
    group.health.push(runHealth(run));
    groups.set(sig.key, group);
  }
  return [...groups.values()]
    .map((g) => {
      // the first run after which the last N were all clean
      let firstHot = -1;
      for (let i = hotAfter - 1; i < g.runs.length && firstHot < 0; i++) {
        if (g.health.slice(i - hotAfter + 1, i + 1).every((h) => h.clean))
          firstHot = i;
      }
      const hot =
        g.runs.length >= hotAfter &&
        g.health.slice(-hotAfter).every((h) => h.clean);
      return {
        ...g,
        hot,
        servable: firstHot < 0 ? 0 : g.runs.length - 1 - firstHot,
      };
    })
    .sort((a, b) => b.runs.length - a.runs.length || a.id.localeCompare(b.id));
}
