// `hotpath learn`: list the paths the agent repeats, compile the hot ones into
// candidates, and make one live after its shadow check (task 10).
import path from "node:path";

import type { Command } from "commander";
import { tracesDir, workflowsDir } from "@hotpathrun/compiler";
import {
  configuredHotAfter,
  formatLearnReport,
  learn,
  promote,
  type LearnDirs,
} from "@hotpathrun/learn";
import { defaultStateDir } from "@hotpathrun/scheduler";

import { repoRoot } from "./wrap/self.js";

function learnDirs(): LearnDirs {
  return {
    tracesDir,
    workflowsDir,
    stateDir: defaultStateDir,
    agentRunFile: path.join(repoRoot, "out", "agent-run.json"),
  };
}

export function addLearnCommand(program: Command): void {
  program
    .command("learn")
    .description(
      "Find the paths your agent repeats and compile the hot ones, with no recording step",
    )
    .option(
      "--promote <path>",
      "make a candidate live (workflows/<path>.json) after its shadow check passes",
    )
    .option(
      "--auto",
      "promote every hot path whose shadow check passes, without asking",
    )
    .option(
      "--hot-after <n>",
      "clean runs in a row that make a path hot (default: learn.hotAfter in hotpath.config.json, else 3)",
    )
    .action(
      async (options: {
        promote?: string;
        auto?: boolean;
        hotAfter?: string;
      }) => {
        try {
          const dirs = learnDirs();
          if (options.promote) {
            const result = await promote(dirs, options.promote);
            if (!result.ok) {
              for (const p of result.problems) console.log(`✗ ${p}`);
              throw new Error(
                `${options.promote} was not promoted: its shadow replay does not do what the agent did. ` +
                  "Run the task with the agent again, then hotpath learn.",
              );
            }
            console.log(
              `${options.promote} is live: ${path.relative(repoRoot, result.workflowFile!)}\n` +
                `run it with: hotpath run ${options.promote} --input <name>=<value>`,
            );
            return;
          }
          const hotAfter = options.hotAfter
            ? parseHotAfter(options.hotAfter)
            : await configuredHotAfter(
                path.join(repoRoot, "hotpath.config.json"),
              );
          const report = await learn(dirs, { hotAfter, auto: options.auto });
          console.log(formatLearnReport(report));
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      },
    );
}

function parseHotAfter(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `--hot-after must be a whole number of runs, 1 or more (got "${value}")`,
    );
  }
  return n;
}
