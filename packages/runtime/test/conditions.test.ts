// Steps with a condition (`when`, learned from several recordings): a rule
// decides in code, a question is one short yes/no call to the replay model.
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

beforeAll(() => {
  process.env.HOTPATH_REUSE = "0";
});
afterAll(() => {
  delete process.env.HOTPATH_REUSE;
});

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

import {
  chat,
  readTrace,
  type Condition,
  type TemplateContext,
} from "@hotpathrun/shared";
import { compileTrace } from "@hotpathrun/compiler";
import { DriftError, runWorkflow } from "../src/index.js";
import { askPrompt, checkCondition, parseYesNo } from "../src/runtime.js";

const chatMock = vi.mocked(chat);
const reply = (text: string) => ({
  text,
  toolCalls: [],
  promptTokens: 10,
  completionTokens: 2,
  llmCalls: 1,
  rateLimitWaitMs: 0,
});

const ctx: TemplateContext = {
  inputs: { date: "2026-10-01" },
  steps: {
    s1: { result: { emails: [{ subject: "a" }], urgent: true, none: [] } },
  },
};

describe("checkCondition", () => {
  it("empty and not empty: lists, text, objects, missing values", () => {
    expect(
      checkCondition({ kind: "nonEmpty", ref: "steps.s1.result.emails" }, ctx),
    ).toBe(true);
    expect(
      checkCondition({ kind: "nonEmpty", ref: "steps.s1.result.none" }, ctx),
    ).toBe(false);
    expect(
      checkCondition({ kind: "empty", ref: "steps.s1.result.none" }, ctx),
    ).toBe(true);
    expect(
      checkCondition({ kind: "empty", ref: "steps.s1.result.missing" }, ctx),
    ).toBe(true);
  });

  it("equals and notEquals compare the value", () => {
    expect(
      checkCondition(
        { kind: "equals", ref: "steps.s1.result.urgent", value: true },
        ctx,
      ),
    ).toBe(true);
    expect(
      checkCondition(
        { kind: "notEquals", ref: "inputs.date", value: "2026-10-01" },
        ctx,
      ),
    ).toBe(false);
  });

  it("a question is left to the model", () => {
    expect(
      checkCondition(
        { kind: "ask", question: "q", prompt: "", yes: "", no: "" },
        ctx,
      ),
    ).toBeNull();
  });
});

describe("parseYesNo / askPrompt", () => {
  it("reads yes or no, and nothing else", () => {
    expect(parseYesNo("Yes.")).toBe(true);
    expect(parseYesNo("no")).toBe(false);
    expect(parseYesNo("**No**, nothing urgent")).toBe(false);
    expect(parseYesNo("maybe")).toBeNull();
  });

  it("shows this run's data and one example of each answer", () => {
    const when: Extract<Condition, { kind: "ask" }> = {
      kind: "ask",
      question: 'send_message (to="me")',
      prompt: "s1 get_inbox result:\n{{steps.s1.result}}",
      yes: "Server down",
      no: "Lunch menu",
    };
    const p = askPrompt(when, ctx);
    expect(p).toContain('"subject":"a"');
    expect(p).toContain(
      'should the workflow now do this: send_message (to="me")?',
    );
    expect(p).toMatch(/it did, with this data:\nServer down/);
    expect(p).toMatch(/did not, with this data:\nLunch menu/);
    expect(p).toMatch(/Answer with one word: yes or no\.$/);
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
  return workflow;
}

let logs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  chatMock.mockReset();
  logs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
    logs.push(a.join(" "));
  });
});
afterEach(() => logSpy.mockRestore());

describe("conditional steps in a run", () => {
  it("a false rule skips the AI step and the send: no model call, nothing sent", async () => {
    const workflow = await fixtureWorkflow();
    const never: Condition = {
      kind: "equals",
      ref: "inputs.date",
      value: "1999-01-01",
    };
    for (const s of workflow.steps.slice(3)) s.when = never;
    const metrics = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
    });
    expect(chatMock).not.toHaveBeenCalled();
    expect(metrics.llmCalls).toBe(0);
    expect(metrics.steps.filter((s) => s.skipped).map((s) => s.id)).toEqual([
      "s4",
      "s5",
    ]);
    expect(logs.some((l) => l.startsWith("dry-run:"))).toBe(false);
    expect(logs.some((l) => l.includes("↷ s5: skipped"))).toBe(true);
  }, 30_000);

  it("a question answered yes runs the steps; no skips them", async () => {
    const workflow = await fixtureWorkflow();
    const llm = workflow.steps.find((s) => s.type === "llm")!;
    if (llm.type !== "llm") throw new Error("no llm step");
    const ask: Condition = {
      kind: "ask",
      question: 'send_message (to="me")',
      prompt: "{{steps.s1.result}}",
      yes: "busy day",
      no: "quiet day",
    };
    workflow.steps[4]!.when = ask;

    chatMock
      .mockResolvedValueOnce(reply(llm.example))
      .mockResolvedValueOnce(reply("Yes"));
    const ran = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
    });
    expect(ran.steps.some((s) => s.skipped)).toBe(false);
    expect(logs.some((l) => l.startsWith("dry-run:"))).toBe(true);

    chatMock.mockReset();
    logs = [];
    chatMock
      .mockResolvedValueOnce(reply(llm.example))
      .mockResolvedValueOnce(reply("No."));
    const skipped = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
    });
    expect(skipped.steps.find((s) => s.id === "s5")?.skipped).toBe(true);
    expect(skipped.llmCalls).toBe(2);
  }, 30_000);

  it("an answer that is neither yes nor no is drift, not a guess", async () => {
    const workflow = await fixtureWorkflow();
    workflow.steps[3]!.when = {
      kind: "ask",
      question: "write text",
      prompt: "",
      yes: "",
      no: "",
    };
    chatMock.mockResolvedValueOnce(reply("It depends on the weather."));
    const err = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
      noFallback: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriftError);
    expect((err as Error).message).toMatch(
      /could not decide whether to write text/,
    );
  }, 30_000);
});
