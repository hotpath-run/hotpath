import { compileTaskInMemory, saveWorkflow } from "@hotpathrun/compiler";
import { DriftError, recordTools, runWorkflow } from "@hotpathrun/sdk";

import { runAgent, TASK } from "./agent.js";
import { reportsFile, tools } from "./tools.js";

// pnpm --filter sdk-agent start -- record --date 2026-10-01
//   the agent does the task once; its function calls are recorded and compiled
// pnpm --filter sdk-agent start -- run --date 2026-10-02 [--dry-run]
//   the compiled workflow runs on another day's data, calling the same functions

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith("--"));
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const date = flag("--date");

/** The agent does the task with recorded tools; returns the trace file. */
async function record(day: string): Promise<string> {
  const recording = recordTools(tools, { task: TASK, inputs: { date: day } });
  try {
    const result = await runAgent(recording.tools, day);
    console.log(
      `agent: ${result.llmCalls} model calls, tools: ${result.toolCalls.join(", ") || "(none)"}`,
    );
  } finally {
    await recording.finish();
  }
  return (await recording.finish()).traceFile;
}

async function main(): Promise<void> {
  if (!date || (command !== "record" && command !== "run")) {
    console.error(
      "usage: sdk-agent record --date <YYYY-MM-DD>\n" +
        "       sdk-agent run --date <YYYY-MM-DD> [--dry-run]",
    );
    process.exit(1);
  }
  if (command === "record") {
    const traceFile = await record(date);
    const { workflow, warnings, notes } = await compileTaskInMemory(TASK);
    await saveWorkflow(workflow);
    console.log(`recorded ${traceFile}`);
    console.log(
      `compiled ${workflow.steps.length} steps → workflows/${TASK}.json`,
    );
    for (const note of notes) console.log(`+ ${note}`);
    for (const warning of warnings) console.log(`⚠ ${warning}`);
    return;
  }
  try {
    const metrics = await runWorkflow(TASK, {
      tools,
      inputs: { date },
      dryRun: argv.includes("--dry-run"),
      // on drift: the agent does the task again and a new recording is compiled
      agent: argv.includes("--no-fallback")
        ? undefined
        : async (request) => {
            await record(String(request.inputs.date));
          },
    });
    console.log(
      `model calls: ${metrics.llmCalls}, fallback: ${metrics.fallback}, reports in ${reportsFile}`,
    );
  } catch (err) {
    if (!(err instanceof DriftError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
