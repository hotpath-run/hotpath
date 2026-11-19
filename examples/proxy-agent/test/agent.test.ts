// The example agent, unchanged, through the proxy, with the real OpenAI SDK on
// the agent's side and a scripted fake model behind the proxy (no real model).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import path from "node:path";

import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { compileTaskInMemory, saveWorkflow } from "@hotpathrun/compiler";
import {
  fromOpenAiRequest,
  replyToJson,
  replyToStream,
  startProxy,
  type Reply,
  type RunningProxy,
} from "@hotpathrun/proxy";
import { projectRoot } from "@hotpathrun/shared";

import { runAgent } from "../src/agent.js";

const root = projectRoot();
let fake: Server;
let fakeUrl = "";
let proxy: RunningProxy;
let task = "";
let modelCalls = 0;

interface Order {
  id: string;
  customer: string;
  total: number;
}
const reportOf = (orders: Order[]) =>
  "Daily orders report\n" +
  orders.map((o) => `- ${o.id}: ${o.customer}, ${o.total}`).join("\n") +
  `\n${orders.length} orders in total.`;

/** Reads the orders, sends a report naming each one, says it is done. */
function model(body: Record<string, unknown>): Reply {
  const c = fromOpenAiRequest(body);
  const reply = (r: Omit<Reply, "model">): Reply => ({ ...r, model: c.model });
  if (c.tools.length === 0) {
    // an AI step of a replay: write the report from the data in the prompt
    // (orders appear in it as JSON objects; the example's are day 1's, A-1…)
    const prompt = c.messages[0]!.role === "user" ? c.messages[0]!.text : "";
    const orders = [
      ...prompt.matchAll(
        /\{"id":"(A-\d{4})","customer":"([^"]+)","total":([\d.]+)\}/g,
      ),
    ]
      .map((m) => ({ id: m[1]!, customer: m[2]!, total: Number(m[3]) }))
      .filter((o, i, all) => all.findIndex((x) => x.id === o.id) === i)
      .filter((o) => !o.id.startsWith("A-1"));
    return reply({ text: reportOf(orders), toolCalls: [], stop: "stop" });
  }
  const results = c.messages.filter((m) => m.role === "tool");
  const user = c.messages.find((m) => m.role === "user");
  const date = /\d{4}-\d{2}-\d{2}/.exec(
    user?.role === "user" ? user.text : "",
  )![0];
  if (results.length === 0) {
    return reply({
      text: "",
      toolCalls: [
        { id: `call_${++modelCalls}`, name: "get_orders", args: { date } },
      ],
      stop: "tool",
    });
  }
  if (results.length === 1) {
    const r = results[0]!;
    const orders = (
      JSON.parse(r.role === "tool" ? r.content : "{}") as { orders: Order[] }
    ).orders;
    return reply({
      text: "",
      toolCalls: [
        {
          id: `call_${++modelCalls}`,
          name: "send_report",
          args: { to: "ops", text: reportOf(orders) },
        },
      ],
      stop: "tool",
    });
  }
  return reply({ text: "Sent.", toolCalls: [], stop: "stop" });
}

beforeAll(async () => {
  process.env.HOTPATH_REUSE = "0";
  process.env.HOTPATH_JOURNAL = "0";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const reply = model(body);
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(replyToStream("openai", reply));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(replyToJson("openai", reply)));
      }
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  proxy = await startProxy({
    port: 0,
    openaiUpstream: fakeUrl,
    readOnly: ["get_orders"],
    log: () => undefined,
  });
});

afterAll(async () => {
  await proxy.close();
  await new Promise<void>((r) => fake.close(() => r()));
  delete process.env.HOTPATH_REUSE;
  delete process.env.HOTPATH_JOURNAL;
  if (task) {
    await rm(path.join(root, "traces", task), { recursive: true, force: true });
    await rm(path.join(root, "workflows", `${task}.json`), { force: true });
  }
});

describe("proxy-agent", () => {
  it("is recorded, compiled and replayed through the proxy, its code unchanged", async () => {
    const baseURL = `${proxy.url}/v1`;
    const recorded = await runAgent({
      baseURL,
      model: "fake",
      date: "2026-10-01",
      apiKey: ["test", "key"].join("-"),
    });
    expect(recorded.toolCalls.map((c) => c.name)).toEqual([
      "get_orders",
      "send_report",
    ]);
    const [trace] = await proxy.flush();
    task = path.basename(path.dirname(trace!));
    expect(task).toMatch(/^proxy-[0-9a-f]{10}$/);
    const { workflow } = await compileTaskInMemory(task);
    await saveWorkflow(workflow);
    expect(Object.keys(workflow.inputs)).toEqual(["date"]);

    const replayed = await runAgent({
      baseURL,
      model: "fake",
      date: "2026-10-02",
      apiKey: ["test", "key"].join("-"),
    });
    expect(replayed.toolCalls.map((c) => c.name)).toEqual([
      "get_orders",
      "send_report",
    ]);
    expect(replayed.toolCalls[0]!.args).toEqual({ date: "2026-10-02" });
    const sent = replayed.toolCalls[1]!.args;
    expect(sent.to).toBe("ops");
    // today's orders, none of day 1's (how the rows are laid out is the AI step's)
    for (const id of ["A-2001", "A-2002", "A-2003", "A-2004"]) {
      expect(String(sent.text)).toContain(id);
    }
    expect(String(sent.text)).not.toMatch(/A-1\d{3}/);
    expect(proxy.stats.replaysFinished).toBe(1);
    expect(proxy.stats.aiStepCalls).toBe(1);
  });

  it("streams a replayed tool call the OpenAI SDK reads", async () => {
    const client = new OpenAI({
      baseURL: `${proxy.url}/v1`,
      apiKey: ["test", "key"].join("-"),
      maxRetries: 0,
    });
    const stream = await client.chat.completions.create({
      model: "fake",
      stream: true,
      messages: [
        {
          role: "system",
          content:
            "You are the operations assistant of a small coffee wholesaler. " +
            "Write the daily orders report: read the day's orders with get_orders, then call " +
            'send_report with to="ops" and a short text that names every order with its id, ' +
            "customer and total. Then say that it is done.",
        },
        {
          role: "user",
          content: "Send the daily orders report for 2026-10-03.",
        },
      ],
      tools: [
        { type: "function", function: { name: "get_orders", parameters: {} } },
        { type: "function", function: { name: "send_report", parameters: {} } },
      ],
    });
    let name = "";
    let args = "";
    for await (const chunk of stream) {
      for (const tc of chunk.choices[0]?.delta.tool_calls ?? []) {
        name += tc.function?.name ?? "";
        args += tc.function?.arguments ?? "";
      }
    }
    expect(name).toBe("get_orders");
    expect(JSON.parse(args)).toEqual({ date: "2026-10-03" });
  });
});
