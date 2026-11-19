// task 05 at run time: the model is shown the recorded text without its
// list rows and writes only the rest; code writes one row per item of today's
// lists. A model that ignores the markers and writes everything still works.
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

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const fixtureTrace = path.join(
  repoRoot,
  "packages/compiler/test/fixtures/morning-brief.jsonl",
);

vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import { chat, readTrace } from "@hotpathrun/shared";
import { compileTrace } from "@hotpathrun/compiler";
import { runWorkflow } from "../src/index.js";

const chatMock = vi.mocked(chat);
const saved = {
  fixtures: process.env.DEMO_FIXTURES,
  layout: process.env.HOTPATH_LAYOUT,
};

beforeAll(() => {
  process.env.HOTPATH_REUSE = "0";
  process.env.DEMO_FIXTURES = "new-data";
});
afterAll(() => {
  delete process.env.HOTPATH_REUSE;
  if (saved.fixtures === undefined) delete process.env.DEMO_FIXTURES;
  else process.env.DEMO_FIXTURES = saved.fixtures;
});

let logs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  chatMock.mockReset();
  delete process.env.HOTPATH_LAYOUT;
  logs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.join(" "));
  });
});
afterEach(() => {
  logSpy.mockRestore();
  if (saved.layout === undefined) delete process.env.HOTPATH_LAYOUT;
  else process.env.HOTPATH_LAYOUT = saved.layout;
});

async function fixtureWorkflow() {
  const workflow = compileTrace(
    await readTrace(fixtureTrace),
    "fixtures/morning-brief.jsonl",
  );
  workflow.server = [
    `"${process.execPath}"`,
    "--import",
    "tsx",
    "examples/demo-tools/src/index.ts",
  ].join(" ");
  return workflow;
}

const reply = (text: string) => ({
  text,
  toolCalls: [],
  promptTokens: 10,
  completionTokens: 5,
  llmCalls: 1,
  rateLimitWaitMs: 0,
});

/** The text the dry run says it would send. */
function wouldSend(): string {
  const line = logs.find((l) => l.startsWith("dry-run:"));
  if (!line) throw new Error("nothing would be sent");
  return (JSON.parse(line.slice(line.indexOf("{"))) as { text: string }).text;
}

// What a model writes for 2026-10-02 when it follows the skeleton: no list.
const SKELETON_ANSWER = [
  "Good morning! Here is your brief for 2026-10-02.",
  "",
  "Emails:",
  "[[rows:1]]",
  "",
  "Calendar:",
  "[[rows:2]]",
  "",
  "Weather in Paris: Overcast with morning drizzle, high 17°C, low 9°C.",
].join("\n");

const FULL_TEXT = [
  "Good morning! Here is your brief for 2026-10-02.",
  "",
  "Emails:",
  "- Launch checklist for v2 is ready (carol@corp.com)",
  "- Invoice #2041 attached (billing@vendor.io)",
  "- Book club: October pick (dave@club.org)",
  "",
  "Calendar:",
  "- 10:00 Sprint planning, Room A",
  "- 19:30 Dinner with Ana, Le Comptoir",
  "",
  "Weather in Paris: Overcast with morning drizzle, high 17°C, low 9°C.",
].join("\n");

describe("rows written by code", () => {
  it("the model writes the text without the lists; code adds today's rows", async () => {
    chatMock.mockResolvedValue(reply(SKELETON_ANSWER));
    const metrics = await runWorkflow(await fixtureWorkflow(), {
      inputs: { date: "2026-10-02" },
      dryRun: true,
    });

    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(metrics.filledSteps).toEqual(["s4"]);
    // exactly what a model that wrote everything would have had to write
    expect(wouldSend()).toBe(FULL_TEXT);

    const prompt = chatMock.mock.calls[0]![0].messages[0]!.content as string;
    // it is shown the markers, not the recorded rows
    expect(prompt).toContain("[[rows:1]]");
    expect(prompt).toContain("[[rows:2]]");
    expect(prompt).toContain("do not write those lists yourself");
    expect(prompt).not.toContain(
      "- Q3 budget review moved to 14:00 (alice@corp.com)",
    );
    // today's data is still all there
    expect(prompt).toContain("Launch checklist for v2 is ready");
  }, 30_000);

  it("a model that writes the whole text anyway is taken as it is", async () => {
    chatMock.mockResolvedValue(reply(FULL_TEXT));
    const metrics = await runWorkflow(await fixtureWorkflow(), {
      inputs: { date: "2026-10-02" },
      dryRun: true,
    });
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(metrics.filledSteps).toBeUndefined();
    expect(wouldSend()).toBe(FULL_TEXT);
  }, 30_000);

  it("the guards still check the final text: a wrong weather line is retried", async () => {
    chatMock
      .mockResolvedValueOnce(
        reply(SKELETON_ANSWER.replace("Overcast with morning drizzle", "Fine")),
      )
      .mockResolvedValueOnce(reply(FULL_TEXT));
    const metrics = await runWorkflow(await fixtureWorkflow(), {
      inputs: { date: "2026-10-02" },
      dryRun: true,
    });
    expect(chatMock).toHaveBeenCalledTimes(2);
    const retry = chatMock.mock.calls[1]![0].messages[0]!.content as string;
    // only the weather was missing: it is named, and the retry repairs the model's
    // own previous answer (this run's data, rows included) instead of rewriting
    expect(retry).toContain("- Overcast with morning drizzle");
    expect(retry).toContain("Your previous answer:");
    expect(retry).toContain("- Launch checklist for v2 is ready");
    // …and none of the recorded example's facts come back
    expect(retry).not.toContain("Q3 budget review moved to 14:00");
    expect(metrics.steps.every((s) => s.ok)).toBe(true);
    expect(wouldSend()).toBe(FULL_TEXT);
  }, 30_000);

  it("HOTPATH_LAYOUT=0 shows the whole example, as before", async () => {
    process.env.HOTPATH_LAYOUT = "0";
    chatMock.mockResolvedValue(reply(FULL_TEXT));
    const metrics = await runWorkflow(await fixtureWorkflow(), {
      inputs: { date: "2026-10-02" },
      dryRun: true,
    });
    const prompt = chatMock.mock.calls[0]![0].messages[0]!.content as string;
    expect(prompt).not.toContain("[[rows:");
    expect(prompt).toContain(
      "- Q3 budget review moved to 14:00 (alice@corp.com)",
    );
    expect(metrics.filledSteps).toBeUndefined();
  }, 30_000);
});
