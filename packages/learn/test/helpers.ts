import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TraceFile, TraceToolCall } from "@hotpathrun/shared";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "compiler",
  "test",
  "fixtures",
);

/** A recorded trace from the compiler's fixtures, as text. */
export function fixtureText(name: string): string {
  return readFileSync(path.join(fixtures, `${name}.jsonl`), "utf8");
}

/** Parse .jsonl text the way readTrace does (tests stay in memory). */
export function parseTrace(text: string): TraceFile {
  const lines = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const meta = lines.find((l) => l.type === "meta") as TraceFile["meta"];
  const end = lines.find((l) => l.type === "end") as TraceFile["end"];
  const calls = lines.filter(
    (l) => l.type === "tool_call",
  ) as unknown as TraceToolCall[];
  return { meta, calls, end };
}

/**
 * The fixture run on another day: every date replaced, and no label at all
 * (no task name the user chose, no inputs), as an unlabelled run would be.
 */
export function unlabelledRun(name: string, date: string): TraceFile {
  const trace = parseTrace(fixtureText(name).replaceAll("2026-10-01", date));
  return {
    ...trace,
    meta: { ...trace.meta, task: "unlabelled", inputs: {} },
  };
}

export function withCalls(trace: TraceFile, calls: TraceToolCall[]): TraceFile {
  return {
    ...trace,
    calls: calls.map((c, i) => ({ ...c, seq: i + 1 })),
    end: { ...trace.end, toolCalls: calls.length },
  };
}

/** bank-reconciliation with its bank lines split over `pages` pages. */
export function bankRun(date: string, pages: number): TraceFile {
  const base = unlabelledRun("bank-reconciliation", date);
  const pageCalls = base.calls.filter((c) => c.tool === "list_bank_lines");
  const lines = pageCalls.flatMap(
    (c) => (c.result as { lines: unknown[] }).lines,
  );
  const per = Math.ceil(lines.length / pages);
  const split: TraceToolCall[] = [];
  for (let p = 1; p <= pages; p++) {
    split.push({
      ...pageCalls[0]!,
      args: { date, page: p },
      result: {
        page: p,
        lines: lines.slice((p - 1) * per, p * per),
        next_page: p < pages ? p + 1 : null,
      },
    });
  }
  const rest = base.calls.filter((c) => c.tool !== "list_bank_lines");
  return withCalls(base, [...split, ...rest]);
}
