import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
const messagesFile = path.join(repoRoot, "out", "messages.json");
const metricsFile = path.join(repoRoot, "out", "hotpath-run.json");
const fixtureTrace = path.join(
  repoRoot,
  "packages/compiler/test/fixtures/morning-brief.jsonl",
);

// Mock ONLY chat (never hit the real API); pricing, templates and the MCP
// server underneath run for real — via the recorder proxy, so the executed
// tool-call sequence lands in a trace we can compare against the fixture.
vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import { answerKey, chat, readTrace } from "@hotpathrun/shared";
import { compileTrace } from "@hotpathrun/compiler";
import { runWorkflow, type RunMetrics } from "../src/index.js";

const chatMock = vi.mocked(chat);
// The mocked llm must "mention" every value the workflow is grounded on, or
// the grounding guard (rightly) rejects it: reuse the recorded example text.
let MOCK_BRIEF = "";
// The fixture's own data would be answered from the recorded example (answer
// reuse) and never reach the mocked model: these tests are about the model call.
beforeAll(() => {
  process.env.HOTPATH_REUSE = "0";
});
afterAll(() => {
  delete process.env.HOTPATH_REUSE;
});
beforeAll(async () => {
  const { workflow } = await fixtureWorkflow("grounding-seed");
  const llm = workflow.steps.find((st) => st.type === "llm");
  MOCK_BRIEF = `${llm && llm.type === "llm" ? llm.example : ""}
[mocked]`;
});

const recordTasks: string[] = [];
function taskName(): string {
  const t = `m6-run-${Date.now()}-${recordTasks.length}`;
  recordTasks.push(t);
  return t;
}

// Compile the checked-in fixture trace, then route the workflow's MCP server
// through the recorder proxy (which spawns demo-tools).
async function fixtureWorkflow(task: string) {
  const trace = await readTrace(fixtureTrace);
  const workflow = compileTrace(trace, "fixtures/morning-brief.jsonl");
  const quote = (s: string) => `"${s}"`;
  workflow.server = [
    quote(process.execPath),
    "--import",
    "tsx",
    "packages/recorder/src/cli.ts",
    "--task",
    task,
    "--",
    quote(process.execPath),
    "--import",
    "tsx",
    "examples/demo-tools/src/index.ts",
  ].join(" ");
  return { workflow, trace };
}

async function readRecordedTrace(task: string) {
  const dir = path.join(repoRoot, "traces", task);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  files.sort();
  const file = path.join(dir, files[files.length - 1]);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await readTrace(file);
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

let logs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await rm(messagesFile, { force: true });
  await rm(metricsFile, { force: true });
  logs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.join(" "));
  });
  chatMock.mockReset();
  // The call really takes 60ms, 50ms of which it reports as rate-limit waiting.
  chatMock.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 60));
    return {
      text: MOCK_BRIEF,
      toolCalls: [],
      promptTokens: 50,
      completionTokens: 10,
      llmCalls: 1,
      rateLimitWaitMs: 50,
    };
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

describe("runtime (mocked llm, real MCP via recorder)", () => {
  it("executes the same tool-call sequence as the trace and writes metrics", async () => {
    const task = taskName();
    const { workflow, trace } = await fixtureWorkflow(task);

    const metrics: RunMetrics = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
    });

    // summary line
    const summary = logs.find((l) => l.includes("✓"));
    // "· startup 0.3s + tools 45ms + llm 1.1s": tool time shown apart from the llm
    const dur = String.raw`(?:\d+ms|\d+\.\ds)`;
    expect(summary).toMatch(
      new RegExp(
        String.raw`^✓ morning-brief in \d+\.\ds, \$0\.\d{4} \(1 llm call\) · startup ${dur} \+ tools ${dur} \+ llm ${dur} \(\+${dur} rate-limit wait\)$`,
      ),
    );
    const pin = Number(process.env.PRICE_CHEAP_IN ?? 0.95);
    const pout = Number(process.env.PRICE_CHEAP_OUT ?? 4);
    expect(metrics.costUsd).toBeCloseTo((50 * pin + 10 * pout) / 1e6, 9);

    // metrics file
    const written = JSON.parse(await readFile(metricsFile, "utf8"));
    expect(written).toEqual(metrics);
    expect(metrics.fallback).toBe(false);
    expect(metrics.llmCalls).toBe(1);
    expect(metrics.promptTokens).toBe(50);
    expect(metrics.completionTokens).toBe(10);
    expect(metrics.steps).toHaveLength(5);
    expect(metrics.steps.every((s) => s.ok)).toBe(true);

    // time split: tool steps vs the llm step vs server startup
    const ms = (ids: string[]) =>
      metrics.steps
        .filter((s) => ids.includes(s.id))
        .reduce((total, s) => total + s.durationMs, 0);
    // llm time excludes the rate-limit wait, which is reported on its own
    expect(metrics.rateLimitWaitMs).toBe(50);
    expect(metrics.llmMs).toBe(ms(["s4"]) - 50);
    expect(metrics.llmMs).toBeGreaterThanOrEqual(0);
    expect(metrics.toolMs).toBe(ms(["s1", "s2", "s3", "s5"]));
    expect(metrics.connectMs).toBeGreaterThan(0);
    expect(
      metrics.connectMs + metrics.toolMs + metrics.llmMs,
    ).toBeLessThanOrEqual(metrics.durationMs);

    // the brief sent via send_message is the mocked llm text
    const messages = JSON.parse(await readFile(messagesFile, "utf8"));
    expect(messages).toHaveLength(1);
    expect(messages[0].to).toBe("me");
    expect(messages[0].text).toBe(MOCK_BRIEF);

    // executed tool-call sequence equals the trace's; the llm-written
    // send_message.text is replaced by fresh llm output, so compare it
    // separately (below).
    const recorded = await readRecordedTrace(task);
    expect(recorded.calls.map((c) => c.tool)).toEqual(
      trace.calls.map((c) => c.tool),
    );
    expect(recorded.calls[0].args).toEqual({ date: "2026-10-01" });
    expect(recorded.calls[1].args).toEqual(trace.calls[1].args);
    expect(recorded.calls[2].args).toEqual(trace.calls[2].args);
    expect(recorded.calls[3].args.to).toBe("me");
    expect(recorded.calls[3].args.text).toBe(MOCK_BRIEF);
  }, 30_000);

  it("passes HOTPATH_CHEAP_REASONING to the llm step's chat call", async () => {
    const task = taskName();
    const { workflow } = await fixtureWorkflow(task);
    process.env.HOTPATH_CHEAP_REASONING = "low";
    try {
      await runWorkflow(workflow, {
        inputs: { date: "2026-10-01" },
        dryRun: true,
      });
    } finally {
      delete process.env.HOTPATH_CHEAP_REASONING;
    }
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(chatMock.mock.calls[0][0].reasoningEffort).toBe("low");

    // unset: thinking off, a replay step rewrites known data
    chatMock.mockClear();
    await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
    });
    expect(chatMock.mock.calls[0][0].reasoningEffort).toBe("none");
  }, 30_000);

  it("llm prompt carries this run's data and says not to copy the example", async () => {
    const task = taskName();
    const { workflow } = await fixtureWorkflow(task);
    await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
    });
    const prompt = chatMock.mock.calls[0][0].messages[0].content;
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("Q3 budget review moved to 14:00"); // rendered data
    expect(prompt).toMatch(/only the data above/i);
    expect(prompt).toMatch(/must not be copied/i);
    // no exact character target: reasoning models counted while thinking (41k tokens)
    expect(prompt).not.toMatch(/\d+ characters/);
    expect(prompt).toMatch(
      /Reply with the text only: no introduction, no code fences/,
    );
    expect(prompt).toContain(
      "Match the style and length of this example, roughly:",
    );
    expect(prompt.indexOf("must not be copied")).toBeLessThan(
      prompt.indexOf("Match the style and length of this example"),
    );
  }, 30_000);

  it("caps the llm call's tokens and drifts with a clear reason when it is cut off", async () => {
    const task = taskName();
    const { workflow } = await fixtureWorkflow(task);
    chatMock.mockResolvedValueOnce({
      text: "",
      toolCalls: [],
      promptTokens: 500,
      completionTokens: 16_000,
      llmCalls: 1,
      truncated: true,
    });
    await expect(
      runWorkflow(workflow, {
        inputs: { date: "2026-10-01" },
        dryRun: true,
      }),
    ).rejects.toThrow(/16000-token cap \(HOTPATH_CHEAP_MAX_TOKENS\)/);
    expect(chatMock.mock.calls[0][0].maxTokens).toBe(16_000);
  }, 30_000);

  it("keeps a cut-off answer among the rejected outputs (HOTPATH_KEEP_REJECTED=1)", async () => {
    const task = taskName();
    const { workflow } = await fixtureWorkflow(task);
    chatMock.mockResolvedValueOnce({
      text: "half a brief",
      toolCalls: [],
      promptTokens: 500,
      completionTokens: 16_000,
      llmCalls: 1,
      truncated: true,
    });
    process.env.HOTPATH_KEEP_REJECTED = "1";
    try {
      const err = await runWorkflow(workflow, {
        inputs: { date: "2026-10-01" },
        dryRun: true,
      }).catch((e: unknown) => e);
      expect((err as { metrics: RunMetrics }).metrics.rejectedOutputs).toEqual([
        "half a brief",
      ]);
    } finally {
      delete process.env.HOTPATH_KEEP_REJECTED;
    }
  }, 30_000);

  it("--dry-run skips side effects and prints what they would send", async () => {
    const task = taskName();
    const { workflow } = await fixtureWorkflow(task);

    const metrics = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
    });

    // nothing written to out/messages.json
    await expect(readFile(messagesFile, "utf8")).rejects.toThrow();
    // but the read-only steps did run (their step entries are ok)
    expect(metrics.steps.filter((s) => s.ok)).toHaveLength(5);
    // and the would-be payload is printed
    const dryLines = logs.filter((l) => l.startsWith("dry-run:"));
    expect(dryLines).toHaveLength(1);
    expect(dryLines[0]).toContain("send_message");
    expect(dryLines[0]).toContain(
      JSON.stringify({ to: "me", text: MOCK_BRIEF }),
    );

    // the recorder saw no send_message either
    const recorded = await readRecordedTrace(task);
    expect(recorded.calls.map((c) => c.tool)).toEqual([
      "get_emails",
      "get_calendar",
      "get_weather",
    ]);
  }, 30_000);

  it("missing required input → clear error listing inputs and examples", async () => {
    const task = taskName();
    const { workflow } = await fixtureWorkflow(task);

    await expect(runWorkflow(workflow, { inputs: {} })).rejects.toThrow(
      /missing required input.*date.*2026-10-01/s,
    );
  }, 30_000);
});

describe("answer reuse (same data as an earlier run: no model call)", () => {
  const answersFile = (task: string) =>
    path.join(repoRoot, ".hotpath", "answers", `${task}.json`);

  async function reuseWorkflow() {
    const { workflow } = await fixtureWorkflow(taskName());
    // own task name: its answers file is this test's alone
    workflow.task = `reuse-test-${Date.now()}-${recordTasks.length}`;
    await rm(answersFile(workflow.task), { force: true });
    return workflow;
  }

  it("the recorded data gets the recorded example, without asking the model", async () => {
    const workflow = await reuseWorkflow();
    const llm = workflow.steps.find((s) => s.type === "llm")!;
    if (llm.type !== "llm") throw new Error("expected an llm step");
    // The checked-in trace predates today's demo data (shorter snippets), so
    // its key rightly misses: key the step on the data this replay sees.
    await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
      reuse: false,
    });
    const sent = chatMock.mock.calls[0]![0].messages[0]!.content as string;
    const dataPrompt = sent.slice(
      0,
      sent.indexOf("\n\nUse only the data above."),
    );
    expect(llm.inputKey).not.toBe(answerKey(llm.example, dataPrompt));
    llm.inputKey = answerKey(llm.example, dataPrompt);
    chatMock.mockClear();
    logs = [];
    try {
      const metrics = await runWorkflow(workflow, {
        inputs: { date: "2026-10-01" },
        dryRun: true,
        reuse: true,
      });
      expect(chatMock).not.toHaveBeenCalled();
      expect(metrics.llmCalls).toBe(0);
      expect(metrics.reusedSteps).toEqual([llm.id]);
      const dry = logs.find((l) => l.startsWith("dry-run:"))!;
      expect(dry).toContain(JSON.stringify(llm.example).slice(1, 60));
      expect(logs.some((l) => l.includes("reused its answer"))).toBe(true);
    } finally {
      await rm(answersFile(workflow.task), { force: true });
    }
  }, 30_000);

  it("a recording that leaves data out is not reused: the model writes it", async () => {
    // a 1.7B agent once wrote a brief with no emails in it; replays must not copy that
    const workflow = await reuseWorkflow();
    const llm = workflow.steps.find((s) => s.type === "llm")!;
    if (llm.type !== "llm") throw new Error("expected an llm step");
    await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
      reuse: false,
    });
    const sent = chatMock.mock.calls[0]![0].messages[0]!.content as string;
    const dataPrompt = sent.slice(
      0,
      sent.indexOf("\n\nUse only the data above."),
    );
    llm.example = "Good morning! Sunny in Paris today.";
    llm.inputKey = answerKey(llm.example, dataPrompt);
    chatMock.mockClear();
    try {
      const metrics = await runWorkflow(workflow, {
        inputs: { date: "2026-10-01" },
        dryRun: true,
        reuse: true,
      });
      expect(chatMock).toHaveBeenCalled();
      expect(metrics.reusedSteps).toBeUndefined();
    } finally {
      await rm(answersFile(workflow.task), { force: true });
    }
  }, 30_000);

  it("an answer the model gave is reused for the same data, not for other data", async () => {
    const workflow = await reuseWorkflow();
    for (const s of workflow.steps) if (s.type === "llm") delete s.inputKey;
    const run = () =>
      runWorkflow(workflow, {
        inputs: { date: "2026-10-01" },
        dryRun: true,
        reuse: true,
      });
    try {
      expect((await run()).llmCalls).toBe(1);
      const saved = JSON.parse(
        await readFile(answersFile(workflow.task), "utf8"),
      );
      expect(Object.values(saved)).toEqual([
        { output: MOCK_BRIEF, savedAt: expect.any(String) },
      ]);
      const again = await run();
      expect(again.llmCalls).toBe(0);
      expect(chatMock).toHaveBeenCalledTimes(1);

      // a different example (a recompile) is a different question
      const llm = workflow.steps.find((s) => s.type === "llm")!;
      if (llm.type === "llm")
        llm.example = `${llm.example}
Bye.`;
      expect((await run()).llmCalls).toBe(1);
    } finally {
      await rm(answersFile(workflow.task), { force: true });
    }
  }, 30_000);

  it("HOTPATH_REUSE=0 (reuse: false) always asks the model and saves nothing", async () => {
    const workflow = await reuseWorkflow();
    const metrics = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
      reuse: false,
    });
    expect(metrics.llmCalls).toBe(1);
    expect(metrics.reusedSteps).toBeUndefined();
    await expect(
      readFile(answersFile(workflow.task), "utf8"),
    ).rejects.toThrow();
  }, 30_000);

  it("a damaged answers file is ignored, not fatal", async () => {
    const workflow = await reuseWorkflow();
    for (const s of workflow.steps) if (s.type === "llm") delete s.inputKey;
    await mkdir(path.dirname(answersFile(workflow.task)), { recursive: true });
    await writeFile(answersFile(workflow.task), "{not json");
    try {
      const metrics = await runWorkflow(workflow, {
        inputs: { date: "2026-10-01" },
        dryRun: true,
        reuse: true,
      });
      expect(metrics.llmCalls).toBe(1);
    } finally {
      await rm(answersFile(workflow.task), { force: true });
    }
  }, 30_000);
});
