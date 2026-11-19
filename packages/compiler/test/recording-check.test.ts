import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readTrace, type TraceFile } from "@hotpathrun/shared";

import { compileTraceDetailed } from "../src/compiler.js";
import { recordingProblems } from "../src/recording-check.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const check = (trace: TraceFile) => {
  const { workflow, recorded } = compileTraceDetailed(trace, "x");
  return recordingProblems(trace, workflow, recorded);
};
const morning = await readTrace(path.join(fixtures, "morning-brief.jsonl"));
const finance = await readTrace(
  path.join(fixtures, "bank-reconciliation.jsonl"),
);

/** The same recording with one tool call's result replaced. */
function withResult(
  trace: TraceFile,
  tool: string,
  result: unknown,
): TraceFile {
  return {
    ...trace,
    calls: trace.calls.map((c) => (c.tool === tool ? { ...c, result } : c)),
  };
}

describe("recordingProblems", () => {
  it("finds nothing wrong with the two good recordings", () => {
    expect(check(morning)).toEqual([]);
    // -279 and -297.5 are not in the data, but code can recompute both
    expect(check(finance)).toEqual([]);
  });

  it("warns about an error that came back as a normal result", () => {
    const bad = withResult(finance, "list_ledger", {
      error: "ledger service unavailable",
    });
    expect(check(bad).join("\n")).toMatch(
      /list_ledger.*error.*ledger service unavailable/,
    );
  });

  it("warns about an empty answer", () => {
    expect(
      check(withResult(morning, "get_calendar", { events: [] })).join("\n"),
    ).toMatch(/get_calendar returned an empty list \(events\)/);
  });

  it("warns about the same call repeated", () => {
    const first = morning.calls[0]!;
    const stuck = {
      ...morning,
      calls: [first, first, first, ...morning.calls.slice(1)],
    };
    expect(check(stuck).join("\n")).toMatch(
      /called get_emails.*3 times in a row/,
    );
  });

  it("warns about a figure in the text that nothing explains", () => {
    const send = finance.calls.at(-1)!;
    const wrong = {
      ...finance,
      calls: [
        ...finance.calls.slice(0, -1),
        {
          ...send,
          args: {
            ...send.args,
            text: String(send.args.text).replace("-297.5", "-332"),
          },
        },
      ],
    };
    expect(check(wrong).join("\n")).toMatch(
      /figures that no tool returned.*332/,
    );
  });
});

describe("recordingProblems: a failed call the agent recovered from", () => {
  it("says nothing when a later call of the same tool answered", () => {
    const first = morning.calls[0]!;
    const retried = {
      ...morning,
      calls: [
        { ...first, isError: true, result: "503 service unavailable, retry" },
        ...morning.calls,
      ],
    };
    expect(check(retried)).toEqual([]);
  });
});
