import { describe, expect, it } from "vitest";

import {
  formatPassRates,
  formatTable,
  llmArgKeys,
  missingMentions,
  passRates,
  expectedCalls,
  sequenceMatches,
  type ScenarioResult,
} from "../src/lib.js";

describe("missingMentions", () => {
  it("is case-insensitive and lists what is absent", () => {
    expect(
      missingMentions("Standup with platform team; sunny", [
        "Standup with Platform team",
        "Sunny",
        "Dentist appointment",
      ]),
    ).toEqual(["Dentist appointment"]);
  });
});

describe("missingMentions typography", () => {
  it("treats non-breaking hyphens, narrow spaces and curly quotes as plain ones", () => {
    const text =
      "Incidents: INC‑101 “Database failover”; uptime 99.95 %; multi‑currency";
    expect(
      missingMentions(text, [
        "INC-101",
        '"Database failover"',
        "99.95 %",
        "multi-currency",
      ]),
    ).toEqual([]);
  });

  it("still reports a mention that is genuinely absent", () => {
    expect(missingMentions("INC‑101 only", ["INC-101", "INC-205"])).toEqual([
      "INC-205",
    ]);
  });
});

describe("expectedCalls", () => {
  it("leaves out the failed calls the compiler drops", () => {
    // a small agent asked for email "1" instead of "e1": three errors, then the send
    const calls = [
      { tool: "get_inbox", args: { date: "2026-10-01" } },
      { tool: "get_email", args: { id: "1" }, isError: true },
      { tool: "get_email", args: { id: "2" }, isError: true },
      { tool: "send_message", args: { to: "me", text: "digest" } },
    ];
    expect(expectedCalls(calls)).toEqual([
      { tool: "get_inbox", args: { date: "2026-10-01" } },
      { tool: "send_message", args: { to: "me", text: "digest" } },
    ]);
  });
});

describe("sequenceMatches", () => {
  const trace = [
    { tool: "get_emails", args: { date: "2026-10-01" } },
    { tool: "send_message", args: { to: "me", text: "recorded brief" } },
  ];
  const ignore = new Set(["send_message.text"]);

  it("ignores llm-written args but compares everything else", () => {
    const actual = [
      { tool: "get_emails", args: { date: "2026-10-01" } },
      { tool: "send_message", args: { to: "me", text: "fresh text" } },
    ];
    expect(sequenceMatches(actual, trace, ignore)).toBeNull();
  });

  it("accepts the same reads in another order, not other messages", () => {
    const send = { tool: "send_message", args: { to: "me", text: "x" } };
    const a = { tool: "get_a", args: { page: 1 } };
    const b = { tool: "get_b", args: {} };
    const c = { tool: "get_a", args: { page: 2 } };
    expect(
      sequenceMatches([a, c, b, send], [a, b, c, send], ignore),
    ).toBeNull();
    const other = { tool: "send_message", args: { to: "boss", text: "x" } };
    expect(
      sequenceMatches([a, c, b, other], [a, b, c, send], ignore),
    ).not.toBeNull();
  });

  it("reports a differing arg", () => {
    const actual = [
      { tool: "get_emails", args: { date: "2026-10-02" } },
      { tool: "send_message", args: { to: "me", text: "x" } },
    ];
    expect(sequenceMatches(actual, trace, ignore)).toMatch(/call 1.*date/);
  });

  it("reports differing names and lengths", () => {
    expect(sequenceMatches([], trace, ignore)).toMatch(/2 calls/);
    expect(
      sequenceMatches(
        [
          { tool: "get_calendar", args: {} },
          { tool: "send_message", args: { to: "me" } },
        ],
        trace,
        ignore,
      ),
    ).toMatch(/call 1.*get_calendar/);
  });
});

describe("llmArgKeys", () => {
  it("finds tool args fed by an llm step output", () => {
    const keys = llmArgKeys([
      { type: "tool", tool: "get_emails", args: { date: "{{inputs.date}}" } },
      { type: "llm" },
      {
        type: "tool",
        tool: "send_message",
        args: { to: "me", text: "{{steps.s4.output}}" },
      },
    ]);
    expect([...keys]).toEqual(["send_message.text"]);
  });
});

describe("formatTable", () => {
  const rows: ScenarioResult[] = [
    {
      scenario: "same-data",
      pass: true,
      agent: { durationMs: 38200, costUsd: 0.041 },
      hotpath: {
        durationMs: 600,
        costUsd: 0.0021,
        connectMs: 310,
        toolMs: 45,
        llmMs: 1100,
      },
      match: true,
      fallback: false,
    },
    {
      scenario: "new-data",
      pass: true,
      agent: null,
      hotpath: { durationMs: 700, costUsd: 0.0022 },
      match: true,
      fallback: false,
    },
    {
      scenario: "drift",
      pass: true,
      agent: null,
      hotpath: { durationMs: 44100, costUsd: 0.0452 },
      recovered: { durationMs: 600, connectMs: 300, toolMs: 38, llmMs: 90 },
      match: true,
      fallback: true,
    },
  ];

  it("renders speedup, cheaper factor, match and fallback", () => {
    const table = formatTable(rows);
    expect(table).toContain("same-data");
    expect(table).toMatch(/38\.2s \/ \$0\.0410/);
    expect(table).toMatch(/0\.6s \/ \$0\.0021/);
    expect(table).toMatch(/64x/);
    expect(table).toMatch(/20x/);
    expect(table).toMatch(/44\.1s \/ \$0\.0452 → 0\.6s/);
    expect(table).toMatch(/yes → recompiled/);
  });

  it("shows startup, tool and llm time separately", () => {
    const table = formatTable(rows);
    expect(table).toContain("startup + tools + llm");
    expect(table).toContain("310ms + 45ms + 1.1s");
    // drift row shows the recovered (clean) run's split
    expect(table).toContain("300ms + 38ms + 90ms");
    // rows without a split (older results) show a dash instead of crashing
    expect(
      formatTable([{ ...rows[1], hotpath: { durationMs: 1, costUsd: 0 } }]),
    ).toContain("-");
  });

  it("shows failures", () => {
    const table = formatTable([{ ...rows[0], pass: false, match: false }]);
    expect(table).toContain("❌");
  });
});

describe("formatTable rate-limit waits", () => {
  const row = (
    agentWait: number | undefined,
    hotpathWait?: number,
  ): ScenarioResult => ({
    scenario: "t/same-data",
    pass: true,
    agent: { durationMs: 87600, costUsd: 0.0752, rateLimitWaitMs: agentWait },
    hotpath: {
      durationMs: 1900,
      costUsd: 0.0044,
      rateLimitWaitMs: hotpathWait,
    },
    match: true,
    fallback: false,
  });

  it("shows agent time without the wait, and the wait beside it", () => {
    const table = formatTable([row(12400)]);
    expect(table).toContain("75.2s / $0.0752 (+12.4s rate-limit wait)");
  });

  it("computes the speedup from the time excluding waits", () => {
    // 75.2s / 1.9s = 39.6 -> 40x (87.6s / 1.9s would be 46x)
    expect(formatTable([row(12400)])).toMatch(/\b40x\b/);
    expect(formatTable([row(undefined)])).toMatch(/\b46x\b/);
  });

  it("subtracts hotpath waits too", () => {
    const table = formatTable([row(0, 900)]);
    expect(table).toContain("1.0s / $0.0044 (+0.9s rate-limit wait)");
  });

  it("shows no wait note when there was none", () => {
    const table = formatTable([row(0)]);
    expect(table).not.toContain("rate-limit");
  });

  it("drift row: the fallback run's time excludes the agent's waits", () => {
    const table = formatTable([
      {
        scenario: "t/drift",
        pass: true,
        agent: null,
        hotpath: { durationMs: 40000, costUsd: 0.02, rateLimitWaitMs: 10000 },
        recovered: { durationMs: 800 },
        match: true,
        fallback: true,
      },
    ]);
    expect(table).toContain("30.0s / $0.0200 (+10.0s rate-limit wait) → 0.8s");
  });
});

describe("passRates", () => {
  const mk = (scenario: string, ok: boolean): ScenarioResult => ({
    scenario,
    pass: ok,
    agent: null,
    hotpath: { durationMs: 1, costUsd: 0 },
    match: ok,
    fallback: false,
  });

  it("counts passes per scenario across runs, in first-run order", () => {
    const runs = [
      [mk("a/same", true), mk("a/new", true)],
      [mk("a/same", true), mk("a/new", false)],
      [mk("a/same", true), mk("a/new", true)],
    ];
    expect(passRates(runs)).toEqual([
      { scenario: "a/same", passes: 3, runs: 3 },
      { scenario: "a/new", passes: 2, runs: 3 },
    ]);
  });

  it("a scenario that is both pass:false or match:false counts as failed", () => {
    const failedMatch = { ...mk("x", true), match: false };
    expect(passRates([[failedMatch]])).toEqual([
      { scenario: "x", passes: 0, runs: 1 },
    ]);
  });

  it("formats a table with percentages", () => {
    const text = formatPassRates([
      { scenario: "a/same", passes: 3, runs: 3 },
      { scenario: "a/new", passes: 2, runs: 3 },
    ]);
    expect(text).toContain("scenario");
    expect(text).toMatch(/a\/same\s+3\/3\s+100%/);
    expect(text).toMatch(/a\/new\s+2\/3\s+67%/);
  });
});

describe("formatSuiteSummary", () => {
  it("adds up the scenarios of each task and prints a total", async () => {
    const { formatSuiteSummary, OFFICE_TASKS } = await import("../src/lib.js");
    const out = formatSuiteSummary([
      { scenario: "a/same-data", passes: 3, runs: 3 },
      { scenario: "a/drift", passes: 1, runs: 3 },
      { scenario: "b/same-data", passes: 0, runs: 3 },
    ]);
    const lines = out.split("\n").map((l) => l.split(/\s{2,}/));
    expect(lines).toContainEqual(["a", "4/6", "67%"]);
    expect(lines).toContainEqual(["b", "0/3", "0%"]);
    expect(lines).toContainEqual(["TOTAL", "4/9", "44%"]);
    expect(OFFICE_TASKS).toHaveLength(7);
  });
});
