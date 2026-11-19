import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  compileTaskInMemory,
  formatWorkflow,
  saveWorkflow,
} from "@hotpathrun/compiler";
import { startProxy } from "@hotpathrun/proxy";
import { projectRoot } from "@hotpathrun/shared";

import { runAgent, type AgentResult } from "./agent.js";

// pnpm --filter proxy-agent bench [-- --model qwen3.5:4b --runs 1]
// The end-to-end check of task 11 on a local model (free): the same
// agent, unchanged, (1) straight to Ollama on days 2–6, (2) through the proxy:
// record day 1, compile, replay days 2–6. Counts model calls and time per run.

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const upstream = flag(
  "--upstream",
  process.env.HOTPATH_PROXY_OPENAI ?? "http://localhost:11434/v1",
);
const model = flag("--model", "qwen3.5:4b");
const runs = Number(flag("--runs", "1"));
const DAYS = [
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
];

interface Row {
  day: string;
  how: "agent" | "proxy";
  ms: number;
  modelCalls: number;
  servedByHotpath: number;
  handedOver: boolean;
  correct: boolean;
}

/** The report the agent sent names every order of the day. */
async function correct(result: AgentResult, day: string): Promise<boolean> {
  const send = result.toolCalls.find((c) => c.name === "send_report");
  if (!send) return false;
  const fixtures = (await import("../fixtures/orders.json", {
    with: { type: "json" },
  })) as { default: Record<string, Array<{ id: string }>> };
  const text = String(send.args.text ?? "");
  return (fixtures.default[day] ?? []).every((o) => text.includes(o.id));
}

async function main(): Promise<void> {
  const host = new URL(upstream).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    // a remote provider costs money: this script is for the free local model
    throw new Error(
      `the benchmark runs only against a local model (got ${host}); start Ollama, or pass --upstream http://localhost:11434/v1`,
    );
  }
  const rows: Row[] = [];
  const key = process.env.OPENAI_API_KEY ?? "ollama";

  // 1. the agent as it is, straight to the model
  for (let r = 0; r < runs; r++) {
    for (const day of DAYS) {
      const result = await runAgent({
        baseURL: upstream,
        model,
        date: day,
        apiKey: key,
      });
      rows.push({
        day,
        how: "agent",
        ms: result.ms,
        modelCalls: result.requests,
        servedByHotpath: 0,
        handedOver: false,
        correct: await correct(result, day),
      });
      console.log(
        `agent  ${day}: ${result.requests} model calls, ${result.ms} ms`,
      );
    }
  }

  // 2. the same agent through the proxy: one line changed (the base URL)
  const proxy = await startProxy({
    port: 0,
    openaiUpstream: upstream,
    readOnly: ["get_orders"],
    endAfterMs: 200,
  });
  const baseURL = `${proxy.url}/v1`;
  let task = "";
  for (let attempt = 1; attempt <= 3 && !task; attempt++) {
    const recorded = await runAgent({
      baseURL,
      model,
      date: "2026-10-01",
      apiKey: key,
    });
    const [trace] = await proxy.flush();
    if (!trace || !(await correct(recorded, "2026-10-01"))) {
      console.log(
        `record attempt ${attempt}: the agent did not send a full report, again`,
      );
      continue;
    }
    task = path.basename(path.dirname(trace));
  }
  if (!task)
    throw new Error(
      "the agent never sent a full report on day 1: try another --model",
    );
  const { workflow } = await compileTaskInMemory(task);
  await saveWorkflow(workflow);
  console.log(`compiled ${task}:\n${formatWorkflow(workflow)}`);

  for (let r = 0; r < runs; r++) {
    for (const day of DAYS) {
      const before = { ...proxy.stats };
      const result = await runAgent({ baseURL, model, date: day, apiKey: key });
      const s = proxy.stats;
      const modelCalls =
        s.forwarded - before.forwarded + (s.aiStepCalls - before.aiStepCalls);
      rows.push({
        day,
        how: "proxy",
        ms: result.ms,
        modelCalls,
        servedByHotpath: s.servedByHotpath - before.servedByHotpath,
        handedOver: s.handovers > before.handovers,
        correct: await correct(result, day),
      });
      console.log(
        `proxy  ${day}: ${modelCalls} model calls, ${result.ms} ms` +
          (s.handovers > before.handovers ? " (handed to the model)" : ""),
      );
    }
  }
  await proxy.close();

  const sum = (how: Row["how"], pick: (r: Row) => number) =>
    rows.filter((r) => r.how === how).reduce((a, r) => a + pick(r), 0);
  const count = rows.filter((r) => r.how === "agent").length;
  const summary = {
    date: new Date().toISOString(),
    model,
    task,
    runsPerDay: runs,
    agent: {
      modelCallsPerRun: sum("agent", (r) => r.modelCalls) / count,
      msPerRun: Math.round(sum("agent", (r) => r.ms) / count),
      correct: rows.filter((r) => r.how === "agent" && r.correct).length,
    },
    proxy: {
      modelCallsPerRun: sum("proxy", (r) => r.modelCalls) / count,
      msPerRun: Math.round(sum("proxy", (r) => r.ms) / count),
      correct: rows.filter((r) => r.how === "proxy" && r.correct).length,
      handovers: rows.filter((r) => r.how === "proxy" && r.handedOver).length,
    },
    runs: count,
    rows,
  };
  const out = path.join(projectRoot(), "out", "proxy-bench.json");
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
