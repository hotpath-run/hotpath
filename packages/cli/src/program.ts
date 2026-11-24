import { Command, InvalidArgumentError } from "commander";

import {
  compileTaskInMemory,
  confirmWorkflow,
  formatRecordingSummary,
  formatCompileResult,
  formatWorkflow,
  loadWorkflow,
  saveWorkflow,
  tracesDir,
  workflowsDir,
} from "@hotpathrun/compiler";
import { listModels, readTrace } from "@hotpathrun/shared";
import { runRecorder } from "@hotpathrun/recorder";
import {
  runTask,
  verifyOnRecording,
  type RunMetrics,
} from "@hotpathrun/runtime";
import {
  addSchedule,
  applyPlan,
  describePlan,
  planInstall,
  planInstalled,
  processAlive,
  statePaths,
  type InstallPlatform,
  computeStats,
  defaultStateDir,
  formatStats,
  loadBaselines,
  loadSchedules,
  nextRun,
  parseSince,
  readRuns,
  removeSchedule,
  runDueOnce,
  runtimeRunner,
  setScheduleEnabled,
  startDaemon,
  table,
} from "@hotpathrun/scheduler";
import { startViewer } from "@hotpathrun/viewer";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import rootPackage from "../../../package.json" with { type: "json" };

import {
  addAccountCommands,
  addLoginGate,
  defaultAccountDeps,
  type AccountDeps,
} from "./account/commands.js";
import { describeForget, forgetTask, planForget } from "./forget.js";
import { addDemoCommand } from "./demo.js";
import { addLearnCommand } from "./learn.js";
import { addScanCommand } from "./scan.js";
import { registerProxy } from "./proxy.js";
import {
  detachedFlush,
  type AfterCommand,
  runFlush,
  syncAfterCommand,
  type SyncContext,
} from "./sync/background.js";
import { summarizeRun } from "./sync/summary.js";
import { DriftError } from "@hotpathrun/runtime";
import { buildReport, describeReport, writeReport } from "./report.js";
import { formatDoctor, runDoctor } from "./setup/doctor.js";
import { InitError, runInit, type Ask } from "./setup/init.js";
import type { ClaudeScope } from "./wrap/agents.js";
import { repoRoot, selfCommand } from "./wrap/self.js";
import { unwrap, wrap, type WrapResult } from "./wrap/wrap.js";

function passthroughArgs(): string[] {
  const dash = process.argv.indexOf("--");
  return dash >= 0 ? process.argv.slice(dash + 1) : [];
}

function collectInputs(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq <= 0) {
    throw new InvalidArgumentError("expected key=value");
  }
  previous[value.slice(0, eq)] = value.slice(eq + 1);
  return previous;
}

export interface ProgramOptions {
  account?: Partial<AccountDeps>;
  sync?: Partial<SyncContext>;
}

export function createProgram(options: ProgramOptions = {}): Command {
  const account: AccountDeps = {
    ...defaultAccountDeps(rootPackage.version),
    // a caller that picks its own sign-in folder (tests) never moves the
    // user's real one
    ...(options.account?.dir ? { legacyDir: undefined } : {}),
    ...options.account,
  };
  const syncCtx: SyncContext = {
    stateDir,
    workflowsDir,
    env: account.env,
    startFlush: detachedFlush(selfCommand(), account.env),
    ...options.sync,
  };
  const afterCommand: AfterCommand = (runs) => syncAfterCommand(syncCtx, runs);
  const program = new Command();
  program
    .name("hotpath")
    .description("JIT compiler for AI agent tasks")
    .version(rootPackage.version, "-V, --version", "print the version")
    // read in index.ts before anything loads; listed here for --help
    .option(
      "--home <dir>",
      "project folder (traces, workflows, .env); must come first. Default: HOTPATH_HOME, else the folder you are in",
    );
  addLoginGate(program, account);
  addAccountCommands(program, account);
  program
    .command("sync-flush", { hidden: true })
    .description("(internal) send the queued run summaries")
    .action(() =>
      runFlush({
        stateDir: syncCtx.stateDir,
        dir: account.dir,
        env: account.env,
        fetch: account.fetch,
        client: `hotpath-cli/${rootPackage.version}`,
      }),
    );
  program.addHelpText(
    "after",
    `
First steps:
  0. hotpath login                                 sign in (free account; opens your browser)
  1. hotpath init                                  pick a model provider, write .env
  2. hotpath doctor                                check it works; lists your agents
     (hotpath demo                                 try it on the bundled demo agent first)
  3. hotpath wrap claude-code <server> --task <name>   record from your agent
     (or cursor, claude-desktop, vscode, openclaw)
  4. do the task once in your agent, as usual
  5. hotpath compile <name>  then  hotpath run <name> --dry-run
  6. hotpath schedule add <name> --cron "0 7 * * 1-5"   run it on its own`,
  );

  program
    .command("init")
    .description(
      "Set up the model provider and write .env (asks what it needs)",
    )
    .option("--provider <id>", "ollama, openai, groq, openrouter or custom")
    .option("--base-url <url>", "OpenAI-compatible endpoint")
    .option(
      "--api-key <key>",
      "API key (prefer typing it when asked: flags land in shell history)",
    )
    .option("--agent-model <id>", "model that records tasks")
    .option("--cheap-model <id>", "model for the short AI steps in a replay")
    .option("-y, --yes", "accept the defaults, ask nothing")
    .option(
      "--force",
      "replace a key that .env already has for another endpoint (a copy is kept)",
    )
    .action(
      async (options: {
        provider?: string;
        baseUrl?: string;
        apiKey?: string;
        agentModel?: string;
        cheapModel?: string;
        yes?: boolean;
        force?: boolean;
      }) => {
        try {
          await runInit({
            ...options,
            envFile: path.join(repoRoot, ".env"),
            ask: terminalAsk(),
          });
          // marks this folder as the project, so an installed hotpath run
          // from a subfolder finds it (see projectRoot)
          await mkdir(stateDir, { recursive: true });
        } catch (err) {
          if (!(err instanceof InitError)) throw err;
          console.error(`hotpath init: ${err.message}`);
          process.exit(1);
        }
      },
    );

  program
    .command("doctor")
    .description(
      "Check the setup: Node, settings, model provider, agents, tasks",
    )
    .option("--offline", "don't contact the model provider")
    .action(async (options: { offline?: boolean }) => {
      const result = await runDoctor({
        envFile: path.join(repoRoot, ".env"),
        workflowsDir,
        tracesDir,
        env: process.env,
        offline: options.offline,
        listModels,
      });
      console.log(formatDoctor(result));
      if (result.checks.some((c) => c.status === "fail")) process.exitCode = 1;
    });

  program
    .command("record")
    .description("Record an agent run through an MCP proxy")
    .requiredOption("--task <name>", "task name")
    .allowExcessArguments(true)
    .action(async (options: { task: string }) => {
      const serverArgv = passthroughArgs();
      if (serverArgv.length === 0) {
        console.error(
          "usage: hotpath record --task <name> -- <server command…>",
        );
        process.exit(1);
      }
      await runRecorder({ task: options.task, serverArgv });
    });

  program
    .command("compile")
    .description("Compile a trace into a workflow")
    .argument("<task>", "task name")
    .option("--trace <file>", "trace file (default: latest trace for the task)")
    .option(
      "--require <path...>",
      "a field the AI step's text must mention for every item, e.g. steps.s1.result.emails.*.subject",
    )
    .option(
      "--strict",
      "refuse a recording that has a warning: write nothing and exit 1 (then record the task again)",
    )
    .option("--yes", "confirm the recording without asking (CI, scripts)")
    .option(
      "--read-only",
      "the task only reads: accept a recording with no action (kept by later compiles)",
    )
    .action(
      (
        task: string,
        options: {
          trace?: string;
          require?: string[];
          strict?: boolean;
          yes?: boolean;
          readOnly?: boolean;
        },
      ) =>
        guarded(async () => {
          const compiled = await compileTaskInMemory(task, options.trace, {
            require: options.require,
            readOnly: options.readOnly,
          });
          const { workflow, notes } = compiled;
          // replay once on the recorded data (no model, side effects dry):
          // a workflow that cannot reproduce its own recording is not trusted
          const replayed = await verifyOnRecording(
            workflow,
            await readTrace(compiled.traceFile, { allowOpen: true }),
          );
          const warnings = [
            ...compiled.warnings,
            ...replayed.map((p) => `replayed on the recorded data: ${p}`),
          ];
          if (options.strict && warnings.length > 0) {
            for (const warning of warnings) console.log(`⚠ ${warning}`);
            throw new Error(
              `not compiled (--strict): the recording has ${warnings.length} warning${warnings.length === 1 ? "" : "s"}; workflows/${task}.json is unchanged. Record the task again, or compile without --strict.`,
            );
          }
          await saveWorkflow(workflow);
          console.log(formatCompileResult(workflow));
          for (const note of notes) console.log(`+ ${note}`);
          for (const warning of warnings) console.log(`⚠ ${warning}`);
          console.log(`\n${formatRecordingSummary(workflow)}`);
          // never prompt without a terminal: leave it unconfirmed and say how
          const ok =
            options.yes ||
            (process.stdin.isTTY && (await confirm("\nis this right? [y/N] ")));
          if (ok) {
            await confirmWorkflow(task);
            console.log(`confirmed "${task}": it can now replay`);
          } else {
            console.log(
              `not confirmed: "${task}" will not replay until you run: hotpath confirm ${task}`,
            );
          }
          await afterCommand();
        }),
    );

  program
    .command("confirm")
    .description("Confirm a compiled workflow so it may replay")
    .argument("<task>", "task name")
    .action((task: string) =>
      guarded(async () => {
        const workflow = await confirmWorkflow(task);
        console.log(formatRecordingSummary(workflow));
        console.log(`confirmed "${task}": it can now replay`);
      }),
    );

  program
    .command("show")
    .description("Show a workflow as a readable list of steps")
    .argument("<task>", "task name")
    .action(async (task: string) => {
      console.log(formatWorkflow(await loadWorkflow(task)));
    });

  program
    .command("run")
    .description("Run a compiled workflow")
    .argument("<task>", "task name")
    .option(
      "--input <key=value...>",
      "workflow inputs",
      collectInputs,
      {} as Record<string, string>,
    )
    .option(
      "--dry-run",
      "skip side-effect steps and print what they would send",
    )
    .option(
      "--no-fallback",
      "on drift, exit non-zero instead of falling back to the agent",
    )
    .option(
      "--accept-recompile",
      "after a fallback, replace the workflow even if the recompile lost read-only steps",
    )
    .action(
      async (
        task: string,
        options: {
          input: Record<string, string>;
          dryRun?: boolean;
          fallback: boolean;
          acceptRecompile?: boolean;
        },
      ) => {
        const startedAt = new Date();
        let metrics: RunMetrics | undefined;
        let ok = true;
        try {
          metrics = await runTask(task, {
            inputs: options.input,
            dryRun: options.dryRun,
            noFallback: !options.fallback,
            acceptRecompile: options.acceptRecompile,
          });
        } catch (err) {
          ok = false;
          if (err instanceof DriftError) metrics = err.metrics;
          console.error(err instanceof Error ? err.message : String(err));
        }
        if (metrics) {
          // the workflow's recorded baseline: what the agent run it came from took
          const baseline = await loadWorkflow(task)
            .then((w) => w.baseline)
            .catch(() => undefined);
          await afterCommand([
            summarizeRun({
              workflow: task,
              kind: "replay",
              ok,
              dryRun: options.dryRun,
              metrics,
              baseline,
              startedAt,
            }),
          ]);
        }
        if (!ok) process.exit(1);
      },
    );

  program
    .command("view")
    .description("Open the workflow graph viewer")
    .argument("<task>", "task name")
    .option("--port <port>", "port for the local viewer server", "5173")
    .option("--no-open", "don't open the browser")
    .action(async (task: string, options: { port: string; open: boolean }) => {
      try {
        const viewer = await startViewer(task, {
          port: Number(options.port),
          open: options.open,
        });
        console.log(`viewer for "${task}": ${viewer.url} (Ctrl+C to stop)`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  registerProxy(program);

  program
    .command("wrap")
    .description("Route an agent's MCP server through the recorder")
    .argument(
      "<agent>",
      "claude-code, cursor, claude-desktop, vscode or openclaw",
    )
    .argument("<server>", "MCP server name in the agent's config")
    .requiredOption("--task <name>", "task name to record under")
    .option("--dry-run", "print the change without writing anything")
    .option("--config <path>", "agent config file (default: the agent's own)")
    .option(
      "--scope <scope>",
      "local (claude-code only), project or user",
      parseScope,
    )
    .action(
      async (
        agent: string,
        server: string,
        options: {
          task: string;
          dryRun?: boolean;
          config?: string;
          scope?: ClaudeScope;
        },
      ) => {
        await reportWrap(
          () =>
            wrap({ agent, server, ...options, stateDir, self: selfCommand() }),
          options.dryRun
            ? "dry run, nothing written"
            : `wrapped "${server}": ${agent} now records task "${options.task}"\n` +
                `undo with: hotpath unwrap ${agent} ${server}`,
        );
      },
    );

  program
    .command("unwrap")
    .description("Restore an MCP server that `hotpath wrap` changed")
    .argument(
      "<agent>",
      "claude-code, cursor, claude-desktop, vscode or openclaw",
    )
    .argument("<server>", "MCP server name in the agent's config")
    .option("--dry-run", "print the change without writing anything")
    .option(
      "--config <path>",
      "agent config file (default: the one wrap edited)",
    )
    .action(
      async (
        agent: string,
        server: string,
        options: { dryRun?: boolean; config?: string },
      ) => {
        await reportWrap(
          () => unwrap({ agent, server, ...options, stateDir }),
          options.dryRun
            ? "dry run, nothing written"
            : `restored "${server}" in the ${agent} config`,
        );
      },
    );

  program
    .command("forget")
    .description(
      "Delete everything stored for a task: recordings, workflow, saved answers, schedules, history",
    )
    .argument("<task>", "task name")
    .option("--dry-run", "list what would be deleted, delete nothing")
    .option("--yes", "don't ask for confirmation")
    .action((task: string, options: { dryRun?: boolean; yes?: boolean }) =>
      guarded(async () => {
        const dirs = {
          tracesDir,
          workflowsDir,
          stateDir: defaultStateDir,
          outDir: path.join(repoRoot, "out"),
        };
        const items = await planForget(task, dirs);
        console.log(describeForget(task, items));
        if (items.length === 0 || options.dryRun) return;
        if (!options.yes && !(await confirm("\ndelete? [y/N] "))) {
          console.log("nothing changed");
          return;
        }
        await forgetTask(task, dirs);
        console.log(`forgot "${task}"`);
      }),
    );

  program
    .command("report")
    .description(
      "Write a report to send us (versions, stats, runs, workflow structure), with your data left out",
    )
    .option("--task <name>", "only this task")
    .option(
      "--include-traces",
      "add the recordings, with every text and number replaced by its type",
    )
    .option("--out <dir>", "where to write it (default: hotpath-report-<date>)")
    .option("--yes", "don't ask before writing")
    .action(
      (options: {
        task?: string;
        includeTraces?: boolean;
        out?: string;
        yes?: boolean;
      }) =>
        guarded(async () => {
          const now = new Date();
          const dir = path.resolve(
            options.out ??
              path.join(
                repoRoot,
                `hotpath-report-${now.toISOString().slice(0, 10)}`,
              ),
          );
          const doctor = await runDoctor({
            envFile: path.join(repoRoot, ".env"),
            workflowsDir,
            tracesDir,
            env: process.env,
            offline: true,
          });
          const files = await buildReport({
            dirs: {
              tracesDir,
              workflowsDir,
              stateDir: defaultStateDir,
              outDir: path.join(repoRoot, "out"),
            },
            task: options.task,
            includeTraces: options.includeTraces,
            version: rootPackage.version,
            env: process.env,
            doctor,
            now,
            project: repoRoot,
            home: os.homedir(),
          });
          // what is in it, before anything is written
          console.log(describeReport(files, dir));
          if (!options.yes && !(await confirm("\nwrite it? [y/N] "))) {
            console.log("nothing written");
            return;
          }
          await writeReport(dir, files);
          console.log(
            `wrote ${files.size} file${files.size === 1 ? "" : "s"} to ${dir}`,
          );
        }),
    );

  addScheduleCommands(program);
  addDaemonCommands(program);
  addLearnCommand(program, afterCommand);
  addScanCommand(program);
  addDemoCommand(program, afterCommand);

  return program;
}

/** Print the error and exit 1: every scheduler command fails the same way. */
async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function parseFallback(value: string): "auto" | "notify" | "off" {
  if (value === "auto" || value === "notify" || value === "off") return value;
  throw new InvalidArgumentError("expected auto, notify or off");
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError("expected a positive whole number");
  }
  return n;
}

function addScheduleCommands(program: Command): void {
  const schedule = program
    .command("schedule")
    .description("Run compiled workflows on a schedule (see `hotpath daemon`)");

  schedule
    .command("add")
    .description("Add a schedule for a compiled task")
    .argument("<task>", "task name (workflows/<task>.json must exist)")
    .requiredOption("--cron <expr>", 'cron expression, e.g. "0 7 * * 1-5"')
    .option("--tz <zone>", "IANA time zone (default: this computer's)")
    .option(
      "--input <key=value...>",
      "inputs; @today, @yesterday, @tomorrow, @now and @weekday resolve at run time",
      collectInputs,
      {} as Record<string, string>,
    )
    .option(
      "--allow-side-effects",
      "really run side-effect steps (default: dry-run them)",
    )
    .option(
      "--fallback <mode>",
      "on drift: auto (run the agent), notify (default) or off",
      parseFallback,
    )
    .action(
      (
        task: string,
        options: {
          cron: string;
          tz?: string;
          input: Record<string, string>;
          allowSideEffects?: boolean;
          fallback?: "auto" | "notify" | "off";
        },
      ) =>
        guarded(async () => {
          const s = await addSchedule(defaultStateDir, {
            task,
            cron: options.cron,
            timezone: options.tz,
            inputs: options.input,
            allowSideEffects: options.allowSideEffects,
            fallback: options.fallback,
          });
          const next = nextRun(s.cron, s.timezone, new Date());
          console.log(
            `added ${s.id}: ${s.task} at "${s.cron}" (${s.timezone}), next run ${next?.toISOString() ?? "never"}`,
          );
          if (s.sideEffects === "dry-run") {
            console.log(
              "side effects are dry-run: steps marked ⚡ are skipped until you add the schedule with --allow-side-effects",
            );
          }
          console.log("start the scheduler with: hotpath daemon");
        }),
    );

  schedule
    .command("list")
    .description("List schedules with their next run and last status")
    .action(() =>
      guarded(async () => {
        const schedules = await loadSchedules(defaultStateDir);
        if (schedules.length === 0) {
          console.log(
            'no schedules yet — add one with: hotpath schedule add <task> --cron "0 7 * * *"',
          );
          return;
        }
        const runs = await readRuns(defaultStateDir);
        const now = new Date();
        console.log(
          table(
            ["id", "task", "cron", "next run", "enabled", "last status"],
            schedules.map((s) => {
              const last = runs.filter((r) => r.scheduleId === s.id).at(-1);
              return [
                s.id,
                s.task,
                `${s.cron} (${s.timezone})`,
                s.enabled
                  ? (nextRun(s.cron, s.timezone, now)?.toISOString() ?? "never")
                  : "-",
                s.enabled ? "yes" : "no",
                last ? `${last.status} ${last.startedAt}` : "-",
              ];
            }),
          ),
        );
      }),
    );

  schedule
    .command("remove")
    .description("Remove a schedule")
    .argument("<id>", "schedule id (see hotpath schedule list)")
    .action((id: string) =>
      guarded(async () => {
        await removeSchedule(defaultStateDir, id);
        console.log(`removed ${id}`);
      }),
    );

  for (const [name, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    schedule
      .command(name)
      .description(`${enabled ? "Enable" : "Disable"} a schedule`)
      .argument("<id>", "schedule id (see hotpath schedule list)")
      .action((id: string) =>
        guarded(async () => {
          await setScheduleEnabled(defaultStateDir, id, enabled);
          console.log(`${name}d ${id}`);
        }),
      );
  }

  program
    .command("runs")
    .description("Show recent scheduled runs")
    .option("--task <name>", "only this task")
    .option("--limit <n>", "how many", parsePositiveInt, 20)
    .action((options: { task?: string; limit: number }) =>
      guarded(async () => {
        const runs = await readRuns(defaultStateDir, options);
        if (runs.length === 0) {
          console.log("no runs yet");
          return;
        }
        console.log(
          table(
            ["started", "task", "status", "time", "llm", "cost", "note"],
            runs
              .slice()
              .reverse()
              .map((r) => [
                r.startedAt,
                r.task,
                r.status,
                `${(r.durationMs / 1000).toFixed(1)}s`,
                String(r.llmCalls),
                `$${r.costUsd.toFixed(4)}`,
                [
                  r.sideEffectsMode === "dry-run" ? "dry-run" : "",
                  r.fallback ? "agent fallback" : "",
                  r.error ?? "",
                ]
                  .filter(Boolean)
                  .join("; ")
                  .slice(0, 80),
              ]),
          ),
        );
      }),
    );

  program
    .command("stats")
    .description("Runs, success rate, cost and estimated savings per task")
    .option("--since <window>", "time window: 90m, 12h, 30d, 2w", "30d")
    .action((options: { since: string }) =>
      guarded(async () => {
        const since = parseSince(options.since, new Date());
        const runs = await readRuns(defaultStateDir, { since });
        const tasks = [...new Set(runs.map((r) => r.task))];
        const stats = computeStats(runs, await loadBaselines(tasks));
        console.log(formatStats(stats, options.since));
      }),
    );
}

function addDaemonCommands(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("Run due schedules in the foreground (Ctrl+C to stop)")
    .action(() =>
      guarded(async () => {
        const handle = await startDaemon({
          stateDir: defaultStateDir,
          runner: runtimeRunner,
        });
        let signals = 0;
        const onSignal = () => {
          signals++;
          if (signals > 1) process.exit(130); // second Ctrl+C: don't wait
          console.log("stopping… (Ctrl+C again to force)");
          void handle.stop();
        };
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
        await handle.done;
        process.exit(0);
      }),
    );

  const plan = () => {
    const platform = (
      ["win32", "darwin"].includes(process.platform)
        ? process.platform
        : "linux"
    ) as InstallPlatform;
    return planInstall(platform, {
      argv: [...selfCommand(), "daemon"],
      projectDir: repoRoot,
      home: os.homedir(),
      uid: process.getuid?.(),
    });
  };

  for (const action of ["install", "uninstall"] as const) {
    daemon
      .command(action)
      .description(
        action === "install"
          ? "Start the daemon at login for this user (Task Scheduler, launchd or systemd)"
          : "Stop starting the daemon at login",
      )
      .option("--yes", "don't ask for confirmation")
      .action((options: { yes?: boolean }) =>
        guarded(async () => {
          const p = plan();
          console.log(describePlan(p, action));
          if (!options.yes && !(await confirm(`\n${action}? [y/N] `))) {
            console.log("nothing changed");
            return;
          }
          await applyPlan(p, action);
          console.log(
            action === "install"
              ? `installed ${p.name}: the daemon starts at login (and now, where the OS supports it)`
              : `uninstalled ${p.name}`,
          );
        }),
      );
  }

  daemon
    .command("status")
    .description("Is the daemon installed, and is it running for this project?")
    .action(() =>
      guarded(async () => {
        const p = plan();
        console.log(
          `start at login: ${planInstalled(p) ? `installed (${p.name})` : "not installed (hotpath daemon install)"}`,
        );
        let pid = 0;
        try {
          pid = Number(
            (await readFile(statePaths(defaultStateDir).lock, "utf8")).trim(),
          );
        } catch {
          pid = 0;
        }
        console.log(
          `running: ${pid > 0 && processAlive(pid) ? `yes (pid ${pid})` : "no"}`,
        );
      }),
    );

  program
    .command("run-due")
    .description(
      "Run the schedules that are due now, then exit (for OS schedulers and CI)",
    )
    .requiredOption("--once", "run once and exit (the only mode)")
    .action(() =>
      guarded(() =>
        runDueOnce({ stateDir: defaultStateDir, runner: runtimeRunner }),
      ),
    );
}

const stateDir = path.join(repoRoot, ".hotpath");

/** Questions in a terminal; none when stdin isn't one (then defaults apply). */
function terminalAsk(): Ask | undefined {
  if (!process.stdin.isTTY) return undefined;
  return async (question, opts) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    if (opts?.secret) {
      // echo the question, not what is typed (a key must not land on screen)
      const out = rl as unknown as { _writeToOutput: (s: string) => void };
      const write = out._writeToOutput.bind(rl);
      out._writeToOutput = (s: string) => {
        if (s.includes(question)) write(s);
      };
    }
    try {
      return await rl.question(question);
    } finally {
      rl.close();
      if (opts?.secret) process.stdout.write("\n");
    }
  };
}

function parseScope(value: string): ClaudeScope {
  if (value === "local" || value === "project" || value === "user")
    return value;
  throw new InvalidArgumentError("expected local, project or user");
}

async function reportWrap(
  run: () => Promise<WrapResult>,
  done: string,
): Promise<void> {
  try {
    const result = await run();
    console.log(`${result.file}\n${result.diff}\n\n${done}`);
    if (result.changed) console.log(result.reloadHint);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
