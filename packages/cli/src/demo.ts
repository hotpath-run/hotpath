// `hotpath demo`: the smallest end-to-end trial. The bundled demo agent does the
// "morning brief" task 3 times through the recorder, `hotpath learn` compiles the
// path it repeated, and the compiled workflow runs on new data (the model is
// called only for the one step that needs judgment). The tools are fake: the
// message is written to out/messages.json, nothing leaves the machine except
// the model calls.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Command } from "commander";
import { loadWorkflow, tracesDir, workflowsDir } from "@hotpathrun/compiler";
import { formatLearnReport, learn } from "@hotpathrun/learn";
import { runTask } from "@hotpathrun/runtime";
import { defaultStateDir } from "@hotpathrun/scheduler";
import { projectRoot, runningFromSource } from "@hotpathrun/shared";

import { summarizeRun, type RunSummary } from "./sync/summary.js";
import type { AfterCommand } from "./sync/background.js";
import { GATE_MARKER } from "./account/gate.js";
import { runAgent } from "../../../examples/demo-agent/src/agent.js";
import { selfCommand } from "./wrap/self.js";

const TASK = "morning-brief";
/** Most agent runs `hotpath demo` makes before it gives up. */
const MAX_RUNS = 8;

/** Where the demo's fixture folders (default/, new-data/) are. */
export function demoFixturesDir(): string {
  const root = projectRoot();
  if (runningFromSource()) {
    return path.join(root, "examples", "demo-tools", "fixtures");
  }
  // installed: dist/hotpath.mjs, fixtures in demo/fixtures next to dist/
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "demo",
    "fixtures",
  );
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function hasModelSettings(root: string): boolean {
  return (
    Boolean(process.env.LLM_API_KEY) || existsSync(path.join(root, ".env"))
  );
}

export function addDemoCommand(
  program: Command,
  afterCommand: AfterCommand,
): void {
  // The tool server the recorder wraps. Hidden: it speaks MCP on stdout, so it
  // must not print anything else.
  program
    .command("demo-tools", { hidden: true })
    .description("(internal) the demo's fake MCP tool server")
    .action(async () => {
      // An MCP client such as Claude Code starts this with none of the settings
      // `hotpath demo` passes; the demo modules read them when they load.
      process.env.DEMO_FIXTURES_DIR ??= demoFixturesDir();
      process.env.DEMO_OUT_DIR ??= path.join(projectRoot(), "out");
      await import("../../../examples/demo-tools/src/index.js");
    });

  program
    .command("demo")
    .description(
      "Try Hotpath end to end: record the demo agent 3 times, learn the path, replay it",
    )
    .option("--runs <n>", "how many times the agent does the task", "3")
    .action(async (options: { runs: string }) => {
      try {
        const runs = Number(options.runs);
        if (!Number.isInteger(runs) || runs < 3) {
          throw new Error(
            "--runs must be a whole number of at least 3: hotpath learn treats a path as hot after 3 clean runs in a row.",
          );
        }
        const root = projectRoot();
        if (!hasModelSettings(root)) {
          throw new Error(
            "no model is set up here. Run `hotpath init` first (Ollama needs no key: `hotpath init --provider ollama --yes`).",
          );
        }
        const fixtures = demoFixturesDir();
        if (!existsSync(path.join(fixtures, "default", "emails.json"))) {
          throw new Error(`demo fixtures not found in ${fixtures}.`);
        }
        const self = selfCommand();
        const env = {
          DEMO_FIXTURES_DIR: fixtures,
          DEMO_OUT_DIR: path.join(root, "out"),
          DEMO_FIXTURES: "default",
          // the MCP SDK passes a child only the variables listed here, so the
          // recorder it starts would not see that this command passed the login gate
          ...(process.env[GATE_MARKER]
            ? { [GATE_MARKER]: process.env[GATE_MARKER] }
            : {}),
          ...(process.env.HOTPATH_TOKEN
            ? { HOTPATH_TOKEN: process.env.HOTPATH_TOKEN }
            : {}),
          ...(process.env.HOTPATH_NO_SYNC
            ? { HOTPATH_NO_SYNC: process.env.HOTPATH_NO_SYNC }
            : {}),
        };
        const summaries: RunSummary[] = [];
        console.log(
          `Step 1 of 3: the agent does the "${TASK}" task (a model call each; every tool call is recorded)`,
        );
        const dirs = {
          tracesDir,
          workflowsDir,
          stateDir: defaultStateDir,
          agentRunFile: path.join(root, "out", "agent-run.json"),
        };
        // A small model sometimes words one run differently. learn only trusts a
        // path after `runs` clean runs in a row, so record a few more, up to MAX_RUNS.
        let done = 0;
        let id: string | undefined;
        while (!id && done < MAX_RUNS) {
          const batch = done === 0 ? runs : 1;
          for (let k = 0; k < batch; k++, done++) {
            const date = addDays("2026-10-01", done);
            const metrics = await runAgent({
              task: TASK,
              date,
              launch: {
                recorder: [...self, "record", "--task", TASK, "--"],
                server: [...self, "demo-tools"],
                cwd: root,
                env,
              },
            });
            summaries.push(
              summarizeRun({
                workflow: TASK,
                kind: "record",
                ok: true,
                metrics: { ...metrics, fallback: false },
                startedAt: new Date(Date.now() - metrics.durationMs),
              }),
            );
            console.log(
              `  run ${done + 1} (${date}): ${metrics.llmCalls} model calls, ${(metrics.durationMs / 1000).toFixed(1)} s`,
            );
          }
          if (done === runs) {
            console.log("\nStep 2 of 3: hotpath learn (no model call)");
          }
          const report = await learn(dirs, { hotAfter: runs, auto: true });
          id = report.promoted[0] ?? report.paths.find((p) => p.live)?.id;
          if (id || done >= MAX_RUNS) {
            console.log(formatLearnReport(report));
          } else {
            console.log(
              "  learn: not hot yet (the runs differ); the agent tries once more",
            );
          }
        }
        if (!id) {
          throw new Error(
            `learn did not promote a path after ${done} runs: the model words the task differently every time. Use a stronger model for the agent (hotpath init), then run hotpath demo again.`,
          );
        }

        // the replay reads other data, as it would on another day
        process.env.DEMO_FIXTURES = "new-data";
        process.env.DEMO_FIXTURES_DIR = fixtures;
        process.env.DEMO_OUT_DIR = env.DEMO_OUT_DIR;
        const date = addDays("2026-10-01", done);
        console.log(
          `\nStep 3 of 3: replay "${id}" on new data (${date}); the model is called only where judgment is needed`,
        );
        const start = Date.now();
        const replayed = await runTask(id, { inputs: { date } });
        const baseline = await loadWorkflow(id)
          .then((w) => w.baseline)
          .catch(() => undefined);
        summaries.push(
          summarizeRun({
            workflow: id,
            kind: "replay",
            ok: true,
            metrics: replayed,
            baseline,
            startedAt: new Date(start),
          }),
        );
        console.log(
          `replay took ${((Date.now() - start) / 1000).toFixed(1)} s`,
        );
        try {
          const sent = JSON.parse(
            await readFile(path.join(root, "out", "messages.json"), "utf8"),
          ) as Array<{ to: string; text: string }>;
          const last = sent[sent.length - 1];
          if (last)
            console.log(`\nmessage sent to "${last.to}":\n${last.text}`);
        } catch {
          // the demo message file is only a courtesy
        }
        await afterCommand(summaries);
        console.log(
          `\nDone. See the workflow: hotpath show ${id}   or   hotpath view ${id}`,
        );
      } catch (err) {
        console.error(
          `hotpath demo: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });
}
