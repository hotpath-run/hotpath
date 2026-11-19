// The example agent's loop with a scripted model: its function tools are
// recorded through @hotpathrun/sdk and the trace compiles.
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  return { ...actual, chat: vi.fn() };
});

import { compileTaskInMemory, formatWorkflow } from "@hotpathrun/compiler";
import { recordTools, type Tools } from "@hotpathrun/sdk";
import { chat, projectRoot, type LlmResult } from "@hotpathrun/shared";

import { runAgent } from "../src/agent.js";
import { tools } from "../src/tools.js";

const chatMock = vi.mocked(chat);
const task = `sdk-agent-${Date.now()}`;
const sent: Array<{ to: string; text: string }> = [];
// the real reads; a send that stays in memory
const testTools = {
  ...tools,
  send_report: {
    ...tools.send_report,
    execute: async (args: { to: string; text: string }) => {
      sent.push(args);
      return { ok: true, id: "r1" };
    },
  },
} satisfies Tools;

const turn = (
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  text: string | null = null,
): LlmResult => ({
  text,
  toolCalls: calls.map((c, i) => ({ id: `c${i}`, ...c })),
  promptTokens: 1,
  completionTokens: 1,
  llmCalls: 1,
});

const REPORT =
  "Daily report 2026-10-01\nOrders: A-1001 Brasserie Lutèce 412.5; A-1002 Atelier Vernet 89; A-1003 Hôtel Mirabeau 1730.\n" +
  "Stock: Espresso beans 250 g (4 left); Paper filters x100 (0 left).";

beforeEach(() => {
  chatMock.mockReset();
  sent.length = 0;
});
afterAll(async () => {
  await rm(path.join(projectRoot(), "traces", task), {
    recursive: true,
    force: true,
  });
});

describe("sdk-agent", () => {
  it("reads, then sends; an action planned with the reads waits a turn", async () => {
    const date = "2026-10-01";
    chatMock
      // the model plans everything at once, before seeing any data
      .mockResolvedValueOnce(
        turn([
          { name: "get_orders", arguments: { date } },
          { name: "get_stock_alerts", arguments: { date } },
          { name: "send_report", arguments: { to: "ops", text: "[orders]" } },
        ]),
      )
      .mockResolvedValueOnce(
        turn([{ name: "send_report", arguments: { to: "ops", text: REPORT } }]),
      )
      .mockResolvedValueOnce(turn([], "Done."));

    const recording = recordTools(testTools, { task, inputs: { date } });
    const result = await runAgent(recording.tools, date);
    await recording.finish();

    expect(result.toolCalls).toEqual([
      "get_orders",
      "get_stock_alerts",
      "send_report",
    ]);
    expect(sent).toEqual([{ to: "ops", text: REPORT }]);

    const { workflow, warnings } = await compileTaskInMemory(task);
    expect(warnings).toEqual([]);
    expect(formatWorkflow(workflow)).toBe(
      [
        "s1 tool get_orders(date={{inputs.date}})",
        "s2 tool get_stock_alerts(date={{inputs.date}})",
        "s3 llm (cheap) → s4.text",
        "s4 tool send_report(to=ops, text={{steps.s3.output}}) ⚡",
      ].join("\n"),
    );
  });

  it("a model that answers in text is told once to send the report", async () => {
    chatMock
      .mockResolvedValueOnce(turn([], "Here is the report: …"))
      .mockResolvedValueOnce(
        turn([{ name: "send_report", arguments: { to: "ops", text: REPORT } }]),
      )
      .mockResolvedValueOnce(turn([], "Sent."));
    const result = await runAgent(testTools, "2026-10-01");
    expect(result.toolCalls).toEqual(["send_report"]);
    expect(result.llmCalls).toBe(3);
    // the list is the agent's own and kept growing: look for the nudge in it
    const nudge = chatMock.mock.calls[1]![0].messages.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("Call send_report now"),
    );
    expect(nudge).toBeDefined();
  });
});
