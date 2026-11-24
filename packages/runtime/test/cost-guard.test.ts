// A.8, the replay cost guard. On the hard bench's big logs day a replay sent 1,200 log
// lines to the model and cost about what the agent did, although code counted the
// errors. Lists code fully accounts for are now left out, and a step whose data
// outgrows the recording's by far is warned about.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import { compileRecording } from "@hotpathrun/compiler";
import { chat, type TraceFile, type Workflow } from "@hotpathrun/shared";
import { runWorkflow, type ToolBackend } from "../src/index.js";

const chatMock = vi.mocked(chat);
const SERVICES = ["payments", "search", "auth"] as const;

type Day = Record<string, Record<string, number>>;
/** a service's lines: `info` ok lines, then each error message `n` times */
function logLines(
  date: string,
  svc: string,
  errors: Record<string, number>,
  info: number,
) {
  const at = (i: number) =>
    `${date}T${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`;
  return [
    ...Array.from(
      { length: info },
      (_, i) => `${at(i)} INFO ${svc}: request ok ${i}ms`,
    ),
    ...Object.entries(errors).flatMap(([msg, n]) =>
      Array.from({ length: n }, (_, i) => `${at(i)} ERROR ${svc}: ${msg}`),
    ),
  ];
}
const report = (date: string, day: Day) =>
  `${date} error summary: ` +
  SERVICES.map((s) => {
    const [top, n] = Object.entries(day[s]!).sort((a, b) => b[1] - a[1])[0]!;
    const total = Object.values(day[s]!).reduce((a, b) => a + b, 0);
    return `${s} — ${total} ERROR lines; most frequent: "${top}" (${n} occurrences).`;
  }).join(" ");

const RECORDED: Day = {
  payments: { "db connection reset": 5, "timeout calling upstream": 2 },
  search: { "rate limit exceeded": 8, "timeout calling upstream": 4 },
  auth: { "invalid token signature": 3, "disk quota reached": 1 },
};
const BIG: Day = {
  payments: { "disk quota reached": 30, "db connection reset": 12 },
  search: { "timeout calling upstream": 25, "rate limit exceeded": 9 },
  auth: { "invalid token signature": 41, "timeout calling upstream": 7 },
};
const INFO = { recorded: 40, big: 400 };

function recording(): TraceFile {
  const at = "2026-11-01T10:00:00.000Z";
  const date = "2026-11-01";
  return {
    meta: {
      type: "meta",
      version: 1,
      task: "cost-guard",
      startedAt: at,
      server: "in-process",
      inputs: { date },
      tools: [
        {
          name: "get_logs",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        { name: "send_message", inputSchema: { type: "object" } },
      ],
    },
    calls: [
      ...SERVICES.map((service, i) => ({
        type: "tool_call" as const,
        seq: i + 1,
        tool: "get_logs",
        args: { service },
        result: {
          service,
          lines: logLines(date, service, RECORDED[service]!, INFO.recorded),
        },
        isError: false,
        startedAt: at,
        durationMs: 1,
      })),
      {
        type: "tool_call",
        seq: 4,
        tool: "send_message",
        args: { to: "oncall", text: report(date, RECORDED) },
        result: { ok: true },
        isError: false,
        startedAt: at,
        durationMs: 1,
      },
    ],
    end: { type: "end", endedAt: at, toolCalls: 4 },
  };
}

function tools(date: string, day: Day, info: number): ToolBackend {
  return {
    async call(tool, args) {
      if (tool === "send_message")
        return { value: { ok: true }, isError: false };
      const service = String((args as { service: string }).service);
      return {
        value: { service, lines: logLines(date, service, day[service]!, info) },
        isError: false,
      };
    },
  };
}

let workflow: Workflow;
const sentPrompts = () =>
  chatMock.mock.calls.map((c) => String(c[0].messages.at(-1)!.content));

beforeEach(() => {
  process.env.HOTPATH_REUSE = "0";
  workflow = compileRecording(recording(), "test").workflow;
  chatMock.mockReset();
  chatMock.mockResolvedValue({
    text: report("2026-11-04", BIG),
    toolCalls: [],
    promptTokens: 1,
    completionTokens: 1,
    llmCalls: 1,
    rateLimitWaitMs: 0,
  } as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.HOTPATH_REUSE;
  delete process.env.HOTPATH_TRIM;
  vi.restoreAllMocks();
});

describe("the replay cost guard", () => {
  it("compiles the log lines as left out: code counts the errors and finds the top message", () => {
    const llm = workflow.steps.find((s) => s.type === "llm");
    expect(llm?.type === "llm" && llm.trim).toEqual([
      "steps.s1.result.lines",
      "steps.s2.result.lines",
      "steps.s3.result.lines",
    ]);
    expect(llm?.type === "llm" && llm.inputChars).toBeGreaterThan(0);
  });

  it("a big day sends no log line to the model, only the figures code computed", async () => {
    const metrics = await runWorkflow(workflow, {
      inputs: { date: "2026-11-04" },
      tools: tools("2026-11-04", BIG, INFO.big),
    });
    const [prompt] = sentPrompts();
    expect(prompt).not.toContain("request ok");
    expect(prompt).toContain(
      "auth most frequent ERROR message: invalid token signature (41)",
    );
    expect(prompt).toContain("payments: 42");
    expect(prompt!.length).toBeLessThan(6000);
    expect(metrics.trimmedSteps).toEqual(["s4"]);
    expect(metrics.inputWarnings).toBeUndefined();
  });

  it("with HOTPATH_TRIM=0 it sends everything, and says the step outgrew the recording", async () => {
    process.env.HOTPATH_TRIM = "0";
    const metrics = await runWorkflow(workflow, {
      inputs: { date: "2026-11-04" },
      tools: tools("2026-11-04", BIG, INFO.big),
    });
    expect(sentPrompts()[0]).toContain("request ok");
    expect(metrics.inputWarnings).toEqual([
      expect.objectContaining({ step: "s4" }),
    ]);
    const said = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(said).toMatch(
      /⚠ s4: today's data for the model is [\d,]+ characters, [\d.]+× the recording's/,
    );
  });
});
