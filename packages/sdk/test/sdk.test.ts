// task 04: an agent whose tools are plain functions is recorded and
// replayed without an MCP server. The compiler, the guards and drift are the
// ones MCP users get; only where the tools run differs.
import { rm, writeFile } from "node:fs/promises";
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

// Mock ONLY chat: the functions, the compiler and the guards run for real.
vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import {
  compileTaskInMemory,
  formatWorkflow,
  saveWorkflow,
} from "@hotpathrun/compiler";
import { IN_PROCESS_SERVER, runTask } from "@hotpathrun/runtime";
import {
  chat,
  projectRoot,
  readTrace,
  type Workflow,
} from "@hotpathrun/shared";

import {
  DriftError,
  recordTools,
  runWorkflow,
  type AgentRequest,
  type Tools,
} from "../src/index.js";

const chatMock = vi.mocked(chat);
const root = projectRoot();
const tasks: string[] = [];
const newTask = () => {
  const task = `sdk-${Date.now()}-${tasks.length}`;
  tasks.push(task);
  return task;
};

interface Order {
  id: string;
  customer: string;
  total: number;
}
const DAY1: Order[] = [
  { id: "A-1001", customer: "Brasserie Lutèce", total: 412.5 },
  { id: "A-1002", customer: "Atelier Vernet", total: 89 },
];
const DAY2: Order[] = [
  { id: "A-2001", customer: "Maison Colibri", total: 1250 },
  { id: "A-2002", customer: "Studio Petrichor", total: 64.9 },
  { id: "A-2003", customer: "Librairie Solstice", total: 230 },
];

/** The agent's tools: plain functions over data in this process. */
function makeTools(orders: Record<string, Order[]>, renameField = false) {
  const sent: Array<{ to: string; text: string }> = [];
  const tools = {
    get_orders: {
      description: "Orders placed on a date",
      parameters: {
        type: "object",
        properties: { date: { type: "string" } },
        required: ["date"],
      },
      readOnly: true,
      execute: ({ date }: { date: string }) => ({
        orders: (orders[date] ?? []).map((o) =>
          renameField ? { id: o.id, client: o.customer, total: o.total } : o,
        ),
      }),
    },
    send_report: {
      description: "Send the daily report",
      execute: async ({ to, text }: { to: string; text: string }) => {
        sent.push({ to, text });
        return { ok: true, id: `r${sent.length}` };
      },
    },
  } satisfies Tools;
  return { tools, sent };
}

const report = (orders: Order[], key: "customer" | "client" = "customer") =>
  `Daily orders report\n` +
  orders
    .map((o) => `- ${o.id}: ${key === "customer" ? o.customer : o.customer}`)
    .join("\n") +
  `\n${orders.length} orders in total.`;

/** A stand-in for the agent's model loop: read the orders, send the report. */
async function agentRun(
  task: string,
  date: string,
  tools: ReturnType<typeof makeTools>["tools"],
  orders: Order[],
) {
  const recording = recordTools(tools, { task, inputs: { date } });
  await recording.tools.get_orders.execute({ date });
  await recording.tools.send_report.execute({
    to: "ops",
    text: report(orders),
  });
  return recording.finish();
}

async function compileAndSave(task: string): Promise<Workflow> {
  const { workflow } = await compileTaskInMemory(task);
  await saveWorkflow(workflow);
  return workflow;
}

let logSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  process.env.HOTPATH_REUSE = "0";
});
afterAll(async () => {
  delete process.env.HOTPATH_REUSE;
  for (const task of tasks) {
    await rm(path.join(root, "traces", task), { recursive: true, force: true });
    await rm(path.join(root, "workflows", `${task}.json`), { force: true });
    await rm(path.join(root, ".hotpath", "answers", `${task}.json`), {
      force: true,
    });
  }
});
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  chatMock.mockReset();
});
afterEach(() => {
  logSpy.mockRestore();
});

const reply = (text: string) => ({
  text,
  toolCalls: [],
  promptTokens: 10,
  completionTokens: 5,
  llmCalls: 1,
});

describe("recordTools", () => {
  it("writes a trace the compiler compiles like an MCP one", async () => {
    const task = newTask();
    const { tools, sent } = makeTools({ "2026-10-01": DAY1 });
    const { traceFile } = await agentRun(task, "2026-10-01", tools, DAY1);

    // the functions really ran, and returned what they always return
    expect(sent).toHaveLength(1);

    const trace = await readTrace(traceFile);
    expect(trace.meta.server).toBe(IN_PROCESS_SERVER);
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
    expect(trace.end.toolCalls).toBe(2);

    const workflow = await compileAndSave(task);
    expect(formatWorkflow(workflow)).toBe(
      [
        "s1 tool get_orders(date={{inputs.date}})",
        "s2 llm (cheap) → s3.text",
        "s3 tool send_report(to=ops, text={{steps.s2.output}}) ⚡",
      ].join("\n"),
    );
    const llm = workflow.steps[1]!;
    expect(llm.type === "llm" && llm.guard.grounding).toContainEqual({
      value: "Brasserie Lutèce",
      paths: ["steps.s1.result.orders.*.customer"],
    });
  });

  it("records a tool that throws as an error, and still throws", async () => {
    const task = newTask();
    const recording = recordTools(
      {
        flaky: {
          readOnly: true,
          execute: () => {
            throw new Error("upstream timed out");
          },
        },
      },
      { task },
    );
    await expect(recording.tools.flaky.execute({})).rejects.toThrow(
      "upstream timed out",
    );
    const { traceFile } = await recording.finish();
    const trace = await readTrace(traceFile);
    expect(trace.calls[0]).toMatchObject({
      tool: "flaky",
      isError: true,
      result: "upstream timed out",
    });
    // finishing twice is the same recording
    expect((await recording.finish()).traceFile).toBe(traceFile);
  });

  it("refuses a task name that is a path", () => {
    expect(() => recordTools({}, { task: "../x" })).toThrow(
      /invalid task name/,
    );
  });
});

describe("runWorkflow", () => {
  it("replays on new data by calling the functions, in order, with the right arguments", async () => {
    const task = newTask();
    const data = { "2026-10-01": DAY1, "2026-10-02": DAY2 };
    const recorded = makeTools(data);
    await agentRun(task, "2026-10-01", recorded.tools, DAY1);
    await compileAndSave(task);

    const replay = makeTools(data);
    const calls: string[] = [];
    const spied = Object.fromEntries(
      Object.entries(replay.tools).map(([name, tool]) => [
        name,
        {
          ...tool,
          execute: (args: never) => {
            calls.push(`${name} ${JSON.stringify(args)}`);
            return tool.execute(args);
          },
        },
      ]),
    ) as Tools;
    chatMock.mockResolvedValue(reply(report(DAY2)));

    const metrics = await runWorkflow(task, {
      tools: spied,
      inputs: { date: "2026-10-02" },
    });

    expect(metrics.fallback).toBe(false);
    expect(metrics.llmCalls).toBe(1);
    expect(calls).toEqual([
      'get_orders {"date":"2026-10-02"}',
      `send_report ${JSON.stringify({ to: "ops", text: report(DAY2) })}`,
    ]);
    expect(replay.sent).toEqual([{ to: "ops", text: report(DAY2) }]);
    // the model was given today's orders, not the recorded ones
    const prompt = chatMock.mock.calls[0]![0].messages[0]!.content as string;
    expect(prompt).toContain("Maison Colibri");
  });

  it("a dry run reads but does not act", async () => {
    const task = newTask();
    const data = { "2026-10-01": DAY1, "2026-10-02": DAY2 };
    await agentRun(task, "2026-10-01", makeTools(data).tools, DAY1);
    await compileAndSave(task);
    const replay = makeTools(data);
    chatMock.mockResolvedValue(reply(report(DAY2)));

    const metrics = await runWorkflow(task, {
      tools: replay.tools,
      inputs: { date: "2026-10-02" },
      dryRun: true,
    });
    expect(metrics.toolCalls.map((c) => c.tool)).toEqual(["get_orders"]);
    expect(replay.sent).toEqual([]);
  });

  it("the guards work as over MCP: text that leaves an order out is drift", async () => {
    const task = newTask();
    const data = { "2026-10-01": DAY1, "2026-10-02": DAY2 };
    await agentRun(task, "2026-10-01", makeTools(data).tools, DAY1);
    await compileAndSave(task);
    const replay = makeTools(data);
    chatMock.mockResolvedValue(reply(report(DAY2.slice(0, 2))));

    const error = await runWorkflow(task, {
      tools: replay.tools,
      inputs: { date: "2026-10-02" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriftError);
    expect((error as DriftError).message).toContain("Librairie Solstice");
    expect(replay.sent).toEqual([]); // nothing was sent
  });

  it("drift in the data runs the given agent once and learns the new shape", async () => {
    const task = newTask();
    const data = { "2026-10-01": DAY1, "2026-10-02": DAY2 };
    await agentRun(task, "2026-10-01", makeTools(data).tools, DAY1);
    await compileAndSave(task);

    // the orders API now says `client` instead of `customer`
    const changed = makeTools(data, true);
    const requests: AgentRequest[] = [];
    chatMock.mockResolvedValue(reply(report(DAY2)));
    const metrics = await runWorkflow(task, {
      tools: changed.tools,
      inputs: { date: "2026-10-02" },
      agent: async (request) => {
        requests.push(request);
        await agentRun(
          request.task,
          String(request.inputs.date),
          changed.tools,
          DAY2,
        );
      },
    });
    expect(requests).toEqual([{ task, inputs: { date: "2026-10-02" } }]);
    expect(metrics.fallback).toBe(true);
    expect(metrics.driftStep).toBe("s1");
    expect(metrics.recompiled).toBe(true);
    expect(changed.sent).toHaveLength(1); // by the agent, once

    // the next run fits again, with no agent
    const next = await runWorkflow(task, {
      tools: changed.tools,
      inputs: { date: "2026-10-02" },
    });
    expect(next.fallback).toBe(false);
    expect(changed.sent).toHaveLength(2);
  });

  it("a tool that throws is a tool error (drift), not a crash", async () => {
    const task = newTask();
    const data = { "2026-10-01": DAY1 };
    await agentRun(task, "2026-10-01", makeTools(data).tools, DAY1);
    await compileAndSave(task);
    const broken = makeTools(data);
    const tools: Tools = {
      ...broken.tools,
      get_orders: {
        readOnly: true,
        execute: () => {
          throw new Error("database is down");
        },
      },
    };
    const error = await runWorkflow(task, {
      tools,
      inputs: { date: "2026-10-01" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriftError);
    expect((error as DriftError).message).toMatch(
      /get_orders returned an error: database is down/,
    );
  });

  it("says which tools are missing before running anything", async () => {
    const task = newTask();
    const data = { "2026-10-01": DAY1 };
    await agentRun(task, "2026-10-01", makeTools(data).tools, DAY1);
    await compileAndSave(task);
    const { get_orders } = makeTools(data).tools;
    await expect(
      runWorkflow(task, { tools: { get_orders }, inputs: { date: "x" } }),
    ).rejects.toThrow(/calls send_report, which is not in the tools passed/);
  });

  it("`hotpath run` on such a workflow says to run it from the agent's code", async () => {
    const task = newTask();
    const data = { "2026-10-01": DAY1 };
    await agentRun(task, "2026-10-01", makeTools(data).tools, DAY1);
    await compileAndSave(task);
    await expect(
      runTask(task, { inputs: { date: "2026-10-01" }, noFallback: true }),
    ).rejects.toThrow(/runWorkflow\s+from @hotpathrun\/sdk/);
  });
});

describe("MCP users are not affected", () => {
  it("a workflow file without tools passed still starts its server command", async () => {
    const task = newTask();
    await writeFile(
      path.join(root, "workflows", `${task}.json`),
      JSON.stringify({
        version: 1,
        task,
        compiledFrom: "x",
        server: "definitely-not-a-real-command-xyz",
        inputs: {},
        steps: [],
      }),
    );
    // it tries the command (and fails to start it): the MCP path is unchanged
    await expect(
      runTask(task, { inputs: {}, noFallback: true }),
    ).rejects.toThrow();
  });
});
