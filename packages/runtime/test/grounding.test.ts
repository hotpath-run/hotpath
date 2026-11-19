import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Answers saved by earlier real runs (.hotpath/answers) would skip the mocked
// model these tests drive: reuse has its own tests in runtime.test.ts.
// A developer's own .env may turn mention repair on (small local models); the
// "off by default" tests below are about the engine's default, not that file.
const repairFromEnv = process.env.HOTPATH_REPAIR_MENTIONS;
beforeAll(() => {
  process.env.HOTPATH_REUSE = "0";
  delete process.env.HOTPATH_REPAIR_MENTIONS;
});
afterAll(() => {
  delete process.env.HOTPATH_REUSE;
  if (repairFromEnv !== undefined) {
    process.env.HOTPATH_REPAIR_MENTIONS = repairFromEnv;
  }
});

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const fixtureTrace = path.join(
  repoRoot,
  "packages/compiler/test/fixtures/morning-brief.jsonl",
);

// Mock ONLY chat; the MCP server, guards and templates run for real.
vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import { chat, readTrace, type TemplateContext } from "@hotpathrun/shared";
import { compileTrace } from "@hotpathrun/compiler";
import {
  DriftError,
  checkGrounding,
  checkStale,
  expandWildcards,
  runWorkflow,
} from "../src/index.js";
import { lineCount } from "../src/runtime.js";

const chatMock = vi.mocked(chat);

describe("lineCount", () => {
  it("counts non-empty lines, at least 1", () => {
    expect(lineCount("Brief\n\nWeather: sun\n  \nDone")).toBe(3);
    expect(lineCount("")).toBe(1);
  });
});

const ctx = (steps: TemplateContext["steps"]): TemplateContext => ({
  inputs: {},
  steps,
});

describe("nested lists (`repos.*.commits.*.message`)", () => {
  const c = ctx({
    s2: {
      results: [
        { commits: [{ message: "fix login bug" }, { message: "add tests" }] },
        { commits: [] },
        { commits: [{ message: "bump version" }] },
      ],
    },
  });
  const path = "steps.s2.results.*.commits.*.message";

  it("expands to one path per item of every list on the way", () => {
    expect(expandWildcards(path, c)).toEqual([
      "steps.s2.results.0.commits.0.message",
      "steps.s2.results.0.commits.1.message",
      "steps.s2.results.2.commits.0.message",
    ]);
    expect(expandWildcards("steps.s9.result.rows.*.name", c)).toEqual([]);
    expect(expandWildcards("steps.s2.results", c)).toEqual([
      "steps.s2.results",
    ]);
  });

  it("every item's field must be mentioned", () => {
    const grounding = [{ value: "x", paths: [path] }];
    expect(
      checkGrounding(grounding, c, "fix login bug; add tests; bump version"),
    ).toEqual([]);
    expect(checkGrounding(grounding, c, "fix login bug")).toEqual([
      "add tests",
      "bump version",
    ]);
  });
});

describe("checkGrounding (pure)", () => {
  const grounding = [
    { value: "Old subject", paths: ["steps.s1.result.emails.0.subject"] },
    { value: 99.95, paths: ["steps.s2.result.uptime"] },
  ];

  it("passes when the output mentions what the paths hold now", () => {
    const c = ctx({
      s1: { result: { emails: [{ subject: "New subject" }] } },
      s2: { result: { uptime: 99.99 } },
    });
    expect(checkGrounding(grounding, c, "New subject, uptime 99.99%")).toEqual(
      [],
    );
  });

  it("checks the CURRENT values, not the recorded ones", () => {
    const c = ctx({
      s1: { result: { emails: [{ subject: "New subject" }] } },
      s2: { result: { uptime: 99.99 } },
    });
    // mentions the recorded values (copied from the example) but not the new ones
    expect(checkGrounding(grounding, c, "Old subject, uptime 99.95%")).toEqual([
      "New subject",
      "99.99",
    ]);
  });

  it("skips entries whose path no longer resolves", () => {
    const c = ctx({ s1: { result: { emails: [] } }, s2: { result: {} } });
    expect(checkGrounding(grounding, c, "anything")).toEqual([]);
  });

  it("with several paths for one value, mentioning any current value is enough", () => {
    const c = ctx({
      s1: { result: { a: "alpha value", b: "beta value" } },
    });
    const g = [
      {
        value: "alpha value",
        paths: ["steps.s1.result.a", "steps.s1.result.b"],
      },
    ];
    expect(checkGrounding(g, c, "just beta value here")).toEqual([]);
    expect(checkGrounding(g, c, "neither")).toEqual(["alpha value"]);
  });

  it("a `*` path requires the field of EVERY current item, each on its own", () => {
    const wildcard = [
      { value: "x", paths: ["steps.s1.result.emails.*.subject"] },
    ];
    const c = ctx({
      s1: {
        result: {
          emails: [
            { subject: "Launch checklist" },
            { subject: "Invoice #2041" },
            { subject: "Book club pick" },
            { subject: "Rent reminder" }, // more items than when recorded
          ],
        },
      },
    });
    expect(
      checkGrounding(wildcard, c, "Launch checklist, Invoice #2041."),
    ).toEqual(["Book club pick", "Rent reminder"]);
    expect(
      checkGrounding(
        wildcard,
        c,
        "Launch checklist, Invoice #2041, Book club pick, Rent reminder",
      ),
    ).toEqual([]);
  });

  it("a `*` path over an empty or missing list asks for nothing", () => {
    const wildcard = [
      { value: "x", paths: ["steps.s1.result.emails.*.subject"] },
    ];
    expect(
      checkGrounding(wildcard, ctx({ s1: { result: { emails: [] } } }), ""),
    ).toEqual([]);
    expect(checkGrounding(wildcard, ctx({ s1: { result: {} } }), "")).toEqual(
      [],
    );
  });

  it("is a no-op without grounding", () => {
    expect(checkGrounding(undefined, ctx({}), "x")).toEqual([]);
    expect(checkGrounding([], ctx({}), "x")).toEqual([]);
  });
});

async function fixtureWorkflow() {
  const trace = await readTrace(fixtureTrace);
  const workflow = compileTrace(trace, "fixtures/morning-brief.jsonl");
  workflow.server = [
    `"${process.execPath}"`,
    "--import",
    "tsx",
    "examples/demo-tools/src/index.ts",
  ].join(" ");
  const llm = workflow.steps.find((s) => s.type === "llm");
  if (!llm || llm.type !== "llm") throw new Error("no llm step in fixture");
  return { workflow, example: llm.example };
}

const reply = (text: string) => ({
  text,
  toolCalls: [],
  promptTokens: 10,
  completionTokens: 5,
  llmCalls: 1,
  rateLimitWaitMs: 0,
});

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  chatMock.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => logSpy.mockRestore());

describe("grounding guard in a run", () => {
  it("one llm call when the output mentions everything", async () => {
    const { workflow, example } = await fixtureWorkflow();
    chatMock.mockResolvedValue(reply(example));
    const metrics = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
    });
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(metrics.llmCalls).toBe(1);
  }, 30_000);

  it("retries once, listing what was left out, then passes", async () => {
    const { workflow, example } = await fixtureWorkflow();
    const lossy = example
      .replaceAll("Dentist appointment", "a visit")
      .replaceAll("Standup with Platform team", "a meeting");
    chatMock
      .mockResolvedValueOnce(reply(lossy))
      .mockResolvedValueOnce(reply(example));

    const metrics = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
    });

    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(metrics.llmCalls).toBe(2);
    const retryPrompt = chatMock.mock.calls[1][0].messages[0].content;
    expect(retryPrompt).toMatch(/left out/i);
    expect(retryPrompt).toContain("- Dentist appointment");
    expect(retryPrompt).toContain("- Standup with Platform team");
    // retries never show the example: small models copy from it
    expect(retryPrompt).not.toMatch(/style and length of this example/);
    // a length a model can see at a glance, not a character count to work out
    expect(retryPrompt).toMatch(
      /Keep it to about \d+ lines\. Reply with the text only/,
    );
    expect(retryPrompt).not.toMatch(/\d+ characters/);
    // the first attempt's prompt is untouched
    expect(chatMock.mock.calls[0][0].messages[0].content).not.toMatch(
      /left out/i,
    );
    expect(metrics.steps.every((s) => s.ok)).toBe(true);
  }, 30_000);

  it("fails the guard (drift at the llm step) if it is still missing after the retry", async () => {
    const { workflow, example } = await fixtureWorkflow();
    const lossy = example.replaceAll("Dentist appointment", "a visit");
    chatMock.mockResolvedValue(reply(lossy));

    const error = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DriftError);
    const drift = error as DriftError;
    expect(drift.stepId).toBe("s4");
    expect(drift.reason).toMatch(/does not mention.*Dentist appointment/);
    expect(chatMock).toHaveBeenCalledTimes(2); // original + exactly one retry
  }, 30_000);

  // Small local models often leave an item out even after the retry; the data is
  // fine, so falling back to the (equally small) agent wastes ~30s. Opt-in repair
  // appends what is missing and says so in the metrics.
  it("repairMentions: appends what is still missing instead of drifting", async () => {
    const { workflow, example } = await fixtureWorkflow();
    const lossy = example.replaceAll("Dentist appointment", "a visit");
    chatMock.mockResolvedValue(reply(lossy));

    const metrics = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
      repairMentions: true,
    });

    expect(chatMock).toHaveBeenCalledTimes(2); // still tries the model first
    expect(metrics.fallback).toBe(false);
    expect(metrics.steps.every((s) => s.ok)).toBe(true);
    expect(metrics.repairedSteps).toEqual(["s4"]);
    // dry-run prints what send_message would have sent
    const wouldSend = logSpy.mock.calls
      .map((c) => c.join(" "))
      .find((l) => l.includes("would send"));
    expect(wouldSend).toContain("Also: Dentist appointment.");
  }, 30_000);

  it("repair is off by default (HOTPATH_REPAIR_MENTIONS unset)", async () => {
    const { workflow, example } = await fixtureWorkflow();
    chatMock.mockResolvedValue(
      reply(example.replaceAll("Dentist appointment", "a visit")),
    );
    const error = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriftError);
  }, 30_000);
});

// The replay model sees the recorded example for style and sometimes copies its
// facts: yesterday's temperature, a clash with yesterday's meeting. Those pass
// the grounding guard (today's facts are there too), so they need their own check.
describe("checkStale (pure)", () => {
  const today = (inputs: Record<string, unknown> = {}): TemplateContext => ({
    inputs,
    steps: {
      s1: { result: { events: [{ title: "Sprint planning", time: "10:00" }] } },
      s2: { result: { city: "Paris", highC: 17, lowC: 9 } },
    },
  });

  it("returns example facts the output repeats that are not in today's data", () => {
    const facts = ["Dentist appointment", "14:00", 21, "Sprint planning"];
    expect(
      checkStale(
        facts,
        today(),
        "Sprint planning, then Dentist appointment at 14:00; 11–21°C",
      ),
    ).toEqual(["Dentist appointment", "14:00", "21"]);
  });

  it("a fact still in today's data is fine, wherever it now sits", () => {
    expect(checkStale(["Paris", 17], today(), "Paris, high 17")).toEqual([]);
  });

  it("a fact that is one of today's inputs is fine (the date the run is for)", () => {
    expect(
      checkStale(
        ["2026-10-01"],
        today({ date: "2026-10-01" }),
        "brief for 2026-10-01",
      ),
    ).toEqual([]);
  });

  it("a fact inside a longer current string is fine", () => {
    expect(checkStale(["Sprint"], today(), "Sprint")).toEqual([]);
  });

  it("is a no-op without facts", () => {
    expect(checkStale(undefined, today(), "x")).toEqual([]);
    expect(checkStale([], today(), "x")).toEqual([]);
  });
});

describe("stale-fact check in a run (new data)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.DEMO_FIXTURES;
    process.env.DEMO_FIXTURES = "new-data";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DEMO_FIXTURES;
    else process.env.DEMO_FIXTURES = saved;
  });

  // a correct brief for fixtures/new-data
  const fresh =
    "Good morning! Here is your brief for 2026-10-02.\n\nEmails:\n" +
    "- Launch checklist for v2 is ready (carol@corp.com)\n" +
    "- Invoice #2041 attached (billing@vendor.io)\n" +
    "- Book club: October pick (dave@club.org)\n\nCalendar:\n" +
    "- 10:00 Sprint planning, Room A\n- 19:30 Dinner with Ana, Le Comptoir\n\n" +
    "Weather in Paris: Overcast with morning drizzle, high 17°C, low 9°C.";
  const copied = `${fresh}\n\nHeads-up: your 14:00 Dentist appointment clashes with the budget review.`;

  it("passes in one call when nothing is copied from the example", async () => {
    const { workflow } = await fixtureWorkflow();
    chatMock.mockResolvedValue(reply(fresh));
    const metrics = await runWorkflow(workflow, {
      inputs: { date: "2026-10-02" },
      dryRun: true,
    });
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(metrics.steps.every((s) => s.ok)).toBe(true);
  }, 30_000);

  it("retries once without the example, then passes", async () => {
    const { workflow } = await fixtureWorkflow();
    chatMock
      .mockResolvedValueOnce(reply(copied))
      .mockResolvedValueOnce(reply(fresh));
    const metrics = await runWorkflow(workflow, {
      inputs: { date: "2026-10-02" },
      dryRun: true,
    });
    expect(chatMock).toHaveBeenCalledTimes(2);
    const retryPrompt = chatMock.mock.calls[1][0].messages[0].content;
    // the model copied from the example, so the retry doesn't show it again,
    // and doesn't name the copied facts either (small models write them back)
    expect(retryPrompt).not.toMatch(/style and length of this example/);
    expect(retryPrompt).not.toContain("Metro line 4 closed this weekend");
    expect(retryPrompt).not.toContain("Dentist appointment");
    expect(retryPrompt).toMatch(/using only the data above/);
    expect(metrics.steps.every((s) => s.ok)).toBe(true);
  }, 30_000);

  it("drifts if the copied facts are still there after the retry, even with repair on", async () => {
    const { workflow } = await fixtureWorkflow();
    chatMock.mockResolvedValue(reply(copied));
    const error = await runWorkflow(workflow, {
      inputs: { date: "2026-10-02" },
      dryRun: true,
      repairMentions: true,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriftError);
    const drift = error as DriftError;
    expect(drift.stepId).toBe("s4");
    expect(drift.reason).toMatch(/not in this run's data.*Dentist appointment/);
    expect(chatMock).toHaveBeenCalledTimes(2);
  }, 30_000);
});
