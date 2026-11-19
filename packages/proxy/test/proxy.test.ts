// task 11: an agent changes its model base URL and nothing else.
// The proxy records its conversations as traces the compiler compiles, answers
// later conversations from the workflow (the model only writes the AI step),
// and hands the conversation to the model when a guard fails.
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
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

import {
  compileTaskInMemory,
  formatWorkflow,
  saveWorkflow,
} from "@hotpathrun/compiler";
import { projectRoot, readTrace } from "@hotpathrun/shared";

import {
  DONE_TEXT,
  PROXY_SERVER,
  startProxy,
  type ApiFormat,
  type RunningProxy,
} from "../src/index.js";
import {
  DAY1,
  DAY2,
  report,
  runAgent,
  startUpstream,
  type FakeUpstream,
} from "./helpers.js";

const root = projectRoot();
const KEY = ["sk", "test", "NEVER", "WRITE", "ME", "0123456789"].join("-");
const tasks: string[] = [];
const newTask = () => {
  const task = `proxy-test-${Date.now()}-${tasks.length}`;
  tasks.push(task);
  return task;
};

let upstream: FakeUpstream;
let proxy: RunningProxy;
let logged: string[];
let consoleLines: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  process.env.HOTPATH_REUSE = "0";
  process.env.HOTPATH_JOURNAL = "0";
});
afterAll(async () => {
  delete process.env.HOTPATH_REUSE;
  delete process.env.HOTPATH_JOURNAL;
  for (const task of tasks) {
    await rm(path.join(root, "traces", task), { recursive: true, force: true });
    await rm(path.join(root, "workflows", `${task}.json`), { force: true });
    await rm(path.join(root, ".hotpath", "answers", `${task}.json`), {
      force: true,
    });
  }
});
beforeEach(async () => {
  logged = [];
  consoleLines = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    consoleLines.push(args.map(String).join(" "));
  });
  upstream = await startUpstream();
  proxy = await startProxy({
    port: 0,
    openaiUpstream: `${upstream.url}/v1`,
    anthropicUpstream: upstream.url,
    readOnly: ["get_orders"],
    endAfterMs: 20,
    log: (line) => logged.push(line),
  });
});
afterEach(async () => {
  await proxy.close();
  await upstream.close();
  logSpy.mockRestore();
});

/** Records one agent run on day 1 through the proxy and compiles it. */
async function recordAndCompile(
  task: string,
  format: ApiFormat,
  stream: boolean,
) {
  const run = await runAgent({
    proxy: proxy.url,
    format,
    stream,
    date: "2026-10-01",
    key: KEY,
    system: `You are the operations assistant (${task}).`,
    headers: { "x-hotpath-task": task },
  });
  const [traceFile] = await proxy.flush();
  const { workflow } = await compileTaskInMemory(task);
  await saveWorkflow(workflow);
  return { run, traceFile: traceFile!, workflow };
}

const MODES: Array<[ApiFormat, boolean]> = [
  ["openai", false],
  ["openai", true],
  ["anthropic", false],
  ["anthropic", true],
];

describe.each(MODES)("%s API, stream=%s", (format, stream) => {
  it("records a conversation as a trace the compiler compiles", async () => {
    const task = newTask();
    const { run, traceFile, workflow } = await recordAndCompile(
      task,
      format,
      stream,
    );

    // the agent got the model's answers, unchanged
    expect(run.calls.map((c) => c.name)).toEqual(["get_orders", "send_report"]);
    expect(run.final).toBe("The report is sent.");
    expect(run.sources.every((s) => s === "forward")).toBe(true);
    expect(upstream.requests).toHaveLength(3);

    const trace = await readTrace(traceFile);
    expect(trace.meta.server).toBe(PROXY_SERVER);
    // the input is what the agent was asked: found in the prompt and the arguments
    expect(trace.meta.inputs).toEqual({ date: "2026-10-01" });
    expect(
      trace.meta.tools.map((t) => [t.name, t.annotations?.readOnlyHint]),
    ).toEqual([
      ["get_orders", true],
      ["send_report", false],
    ]);
    expect(trace.calls.map((c) => [c.seq, c.tool, c.isError])).toEqual([
      [1, "get_orders", false],
      [2, "send_report", false],
    ]);
    expect(trace.calls[0]!.result).toEqual({ orders: DAY1 });

    expect(formatWorkflow(workflow)).toBe(
      [
        "s1 tool get_orders(date={{inputs.date}})",
        "s2 llm (cheap) → s3.text",
        "s3 tool send_report(to=ops, text={{steps.s2.output}}) ⚡",
      ].join("\n"),
    );
  });

  it("replays on new data: today's tool calls, the model only for the AI step", async () => {
    const task = newTask();
    await recordAndCompile(task, format, stream);
    upstream.requests.length = 0;
    upstream.aiText = report(DAY2);

    const start = Date.now();
    // no task header and no inputs: the proxy matches the recorded prompt
    const run = await runAgent({
      proxy: proxy.url,
      format,
      stream,
      date: "2026-10-02",
      key: KEY,
      system: `You are the operations assistant (${task}).`,
    });
    const ms = Date.now() - start;

    expect(run.calls).toEqual([
      { name: "get_orders", args: { date: "2026-10-02" } },
      { name: "send_report", args: { to: "ops", text: report(DAY2) } },
    ]);
    expect(run.sent).toEqual([{ to: "ops", text: report(DAY2) }]);
    expect(run.final).toBe(DONE_TEXT);
    expect(run.sources).toEqual(["replay", "replay", "replay"]);
    // one model call, for the AI step, with the agent's own key
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]!.aiStep).toBe(true);
    // (the Anthropic SDK sends it as a bearer token or as x-api-key)
    const sent = upstream.requests[0]!.headers;
    expect(`${sent.authorization ?? ""} ${sent["x-api-key"] ?? ""}`).toContain(
      KEY,
    );
    expect(proxy.stats).toMatchObject({
      replaysStarted: 1,
      replaysFinished: 1,
      servedByHotpath: 3,
      aiStepCalls: 1,
      handovers: 0,
    });
    expect(ms).toBeLessThan(5000);
  });

  it("hands the whole conversation to the model when a guard fails", async () => {
    const task = newTask();
    await recordAndCompile(task, format, stream);
    upstream.requests.length = 0;
    upstream.aiText = report(DAY2);

    // a tool changed shape: `orders` is now `items`
    const run = await runAgent({
      proxy: proxy.url,
      format,
      stream,
      date: "2026-10-02",
      key: KEY,
      system: `You are the operations assistant (${task}).`,
      getOrders: (date) => ({ items: date === "2026-10-02" ? DAY2 : [] }),
    });

    // the replay asked for get_orders; its result failed the guard, so the
    // model got the conversation as the agent sent it, and finished the task
    expect(run.sources[0]).toBe("replay");
    expect(run.sources.slice(1).every((s) => s === "forward")).toBe(true);
    expect(proxy.stats.handovers).toBe(1);
    expect(logged.some((l) => l.includes("handed to the model"))).toBe(true);
    const first = upstream.requests[0]!;
    expect(first.aiStep).toBe(false);
    const roles = first.conversation.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool"]);
    const result = first.conversation.messages[2]!;
    expect(result.role === "tool" && JSON.parse(result.content)).toEqual({
      items: DAY2,
    });
    // the tool call is the one the replay made, as the agent recorded it
    const asked = first.conversation.messages[1]!;
    expect(asked.role === "assistant" && asked.toolCalls[0]).toMatchObject({
      id: expect.stringMatching(/_hp_/),
      name: "get_orders",
      args: { date: "2026-10-02" },
    });
    // what the model did from there is recorded for the next compile
    await proxy.flush();
    const traces = (await readdir(path.join(root, "traces", task))).filter(
      (f) => f.endsWith(".jsonl"),
    );
    expect(traces).toHaveLength(2);
  });
});

describe("safety", () => {
  it("never repeats an action that ran on the replay's word", async () => {
    const task = newTask();
    await recordAndCompile(task, "openai", false);
    upstream.aiText = report(DAY2);
    // the action answers with something its guard does not expect…
    let sends = 0;
    // …and the model, handed the conversation, asks to send it again
    upstream.script = (c) => {
      const asked = c.messages.flatMap((m) =>
        m.role === "assistant" ? m.toolCalls : [],
      );
      const send = asked.find((t) => t.name === "send_report")!;
      return {
        text: "",
        toolCalls: [{ ...send, id: "call_up_again" }],
        stop: "tool",
        model: c.model,
      };
    };
    const res = await runAgentWithSendResult(task, () => {
      sends += 1;
      return "error: mail server said 451";
    });
    expect(sends).toBe(1);
    expect(res.calls.map((c) => c.name)).toEqual(["get_orders", "send_report"]);
    expect(res.final).toContain("already ran");
  });

  it("listens only on this computer", async () => {
    await expect(startProxy({ host: "0.0.0.0", port: 0 })).rejects.toThrow(
      /only on this computer/,
    );
  });

  it("never writes the key in a trace, a log or an error", async () => {
    const task = newTask();
    const { traceFile } = await recordAndCompile(task, "openai", true);
    upstream.aiText = report(DAY2);
    await runAgent({
      proxy: proxy.url,
      format: "anthropic",
      stream: false,
      date: "2026-10-02",
      key: KEY,
      system: `You are the operations assistant (${task}).`,
    });
    // an upstream that cannot be reached: the error goes back to the agent
    const dead = await startProxy({
      port: 0,
      openaiUpstream: "http://127.0.0.1:1/v1",
      log: (line) => logged.push(line),
    });
    const res = await fetch(`${dead.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const error = await res.text();
    await dead.close();
    expect(res.status).toBe(502);
    expect(error).toContain("Hotpath proxy");

    const dir = path.join(root, "traces", task);
    const files = await readdir(dir);
    const written = await Promise.all(
      files.map((f) => readFile(path.join(dir, f), "utf8")),
    );
    expect(files.some((f) => f.endsWith(".prompt.json"))).toBe(true);
    expect(traceFile).toBeTruthy();
    for (const text of [...written, ...logged, ...consoleLines, error]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("NEVER-WRITE-ME");
    }
  });
});

/** The OpenAI agent, with send_report answering `sendResult` (counted by the caller). */
async function runAgentWithSendResult(task: string, sendResult: () => string) {
  const calls: Array<{ name: string }> = [];
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: `You are the operations assistant (${task}).` },
    { role: "user", content: "Send the daily report for 2026-10-02." },
  ];
  let final = "";
  for (let turn = 0; turn < 6; turn++) {
    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: "fake-model",
        messages,
        tools: [
          {
            type: "function",
            function: { name: "get_orders", parameters: {} },
          },
          {
            type: "function",
            function: { name: "send_report", parameters: {} },
          },
        ],
      }),
    });
    const body = (await res.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };
    const message = body.choices[0]!.message;
    if (!message.tool_calls?.length) {
      final = message.content ?? "";
      break;
    }
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: message.tool_calls,
    });
    for (const tc of message.tool_calls) {
      calls.push({ name: tc.function.name });
      const content =
        tc.function.name === "get_orders"
          ? JSON.stringify({ orders: DAY2 })
          : sendResult();
      messages.push({ role: "tool", tool_call_id: tc.id, content });
    }
  }
  return { calls, final };
}
