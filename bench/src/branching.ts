import { spawn } from "node:child_process";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `pnpm bench:branching [--runs N]` (task 03). Real model calls.
//
//  mail-triage  the agent does the task once per path (urgent → page the
//               on-call, normal → digest, spam → archive); the three
//               recordings compile into one workflow with a branch. Replays:
//               each path on the recorded data and on new data, then a path
//               never recorded (billing): the workflow must fall back to the
//               agent, learn it, and then handle it (and the old paths) alone.
//  inbox-sweep  one recording of "archive only the spam" compiles into a loop
//               with a rule on each email; replayed on a different mailbox.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const outDir = path.join(repoRoot, "out");
const fixturesDir = path.join(repoRoot, "examples/demo-tools/fixtures");
const argv = process.argv.slice(2);
const runs = argv.includes("--runs")
  ? Number(argv[argv.indexOf("--runs") + 1])
  : 1;
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error("--runs needs a positive integer, e.g. --runs 3");
}
const DATE = "2026-10-01";
const TIMEOUT_MS = 10 * 60_000;

function exec(args: string[], fixtures: string) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], {
      cwd: repoRoot,
      env: { ...process.env, DEMO_FIXTURES: fixtures },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
const agent = (task: string, fixtures: string) =>
  exec(
    ["examples/demo-agent/src/index.ts", "--task", task, "--date", DATE],
    fixtures,
  );
const hotpath = (args: string[], fixtures: string) =>
  exec(["packages/cli/src/index.ts", ...args], fixtures);

interface Fixture {
  email: { id: string; subject: string; priority: string };
  mailbox: Array<{ id: string; category: string }>;
}
const fixture = async (set: string) =>
  JSON.parse(
    await readFile(path.join(fixturesDir, set, "triage.json"), "utf8"),
  ) as Fixture;

type Action = { kind: string; subject?: string; id?: string };
const actionsTaken = async (): Promise<Action[]> =>
  JSON.parse(
    await readFile(path.join(outDir, "actions.json"), "utf8").catch(() => "[]"),
  );
const clearActions = () =>
  rm(path.join(outDir, "actions.json"), { force: true });
const lastRun = async () =>
  JSON.parse(
    await readFile(path.join(outDir, "hotpath-run.json"), "utf8").catch(
      () => "{}",
    ),
  ) as { fallback?: boolean; driftStep?: string; recompiled?: boolean };

const TRIAGE_ACTION: Record<string, string> = {
  urgent: "page_oncall",
  normal: "add_to_digest",
  spam: "archive",
  billing: "forward_to_finance",
};

/** What the triage tools must have been asked to do for this fixture. */
async function expectedTriage(set: string): Promise<Action[]> {
  const { email } = await fixture(set);
  const kind = TRIAGE_ACTION[email.priority]!;
  return [
    kind === "archive"
      ? { kind, id: email.id }
      : { kind, subject: email.subject },
  ];
}
async function expectedSweep(set: string): Promise<Action[]> {
  const { mailbox } = await fixture(set);
  return mailbox
    .filter((m) => m.category === "spam")
    .map((m) => ({ kind: "archive", id: m.id }));
}

const sameActions = (got: Action[], want: Action[]) =>
  got.length === want.length &&
  want.every((w, i) =>
    Object.entries(w).every(
      ([k, v]) => (got[i] as Record<string, unknown>)?.[k] === v,
    ),
  );

interface Result {
  scenario: string;
  pass: boolean;
  note: string;
}

async function resetTask(task: string) {
  await rm(path.join(repoRoot, "traces", task), {
    recursive: true,
    force: true,
  });
  await rm(path.join(repoRoot, "workflows", `${task}.json`), { force: true });
}

/** One replay: run the workflow on a fixture set and check what it did. */
async function replay(
  task: string,
  set: string,
  want: Action[],
  expectFallback: boolean,
  scenario: string,
): Promise<Result> {
  await clearActions();
  const run = await hotpath(["run", task, "--input", `date=${DATE}`], set);
  const meta = await lastRun();
  const got = await actionsTaken();
  const notes: string[] = [];
  if (run.code !== 0)
    notes.push(`run failed: ${run.output.trim().slice(-200)}`);
  if (!!meta.fallback !== expectFallback) {
    notes.push(
      expectFallback
        ? "expected a fallback to the agent, there was none"
        : `unexpected fallback at ${meta.driftStep}`,
    );
  }
  if (!sameActions(got, want)) {
    notes.push(`did ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
  }
  const result = { scenario, pass: notes.length === 0, note: notes.join("; ") };
  console.log(
    `  ${result.pass ? "✅" : "❌"} ${scenario}${result.note ? ` — ${result.note}` : ""}`,
  );
  return result;
}

async function triage(): Promise<Result[]> {
  const task = "mail-triage";
  const results: Result[] = [];
  await resetTask(task);
  const recorded = ["triage-urgent", "triage-normal", "triage-spam"];
  for (const set of recorded) {
    await clearActions();
    const rec = await agent(task, set);
    const ok =
      rec.code === 0 &&
      sameActions(await actionsTaken(), await expectedTriage(set));
    console.log(
      `[${task}] recorded ${set}: ${ok ? "agent did the right thing" : "agent got it wrong"}`,
    );
    if (rec.code !== 0)
      throw new Error(`[${task}] agent run failed:\n${rec.output}`);
    if (!ok) {
      results.push({
        scenario: `${task}/record-${set}`,
        pass: false,
        note: "the agent's recording is itself wrong",
      });
    }
  }
  const compiled = await hotpath(["compile", task, "--yes"], "triage-urgent");
  for (const line of compiled.output.split("\n")) {
    if (/^[⚠+] /.test(line) || line.includes("branch"))
      console.log(`[${task}] compile: ${line}`);
  }
  if (compiled.code !== 0)
    throw new Error(`[${task}] compile failed:\n${compiled.output}`);
  const shown = await hotpath(["show", task], "triage-urgent");
  const branches = shown.output.includes("branch");
  results.push({
    scenario: `${task}/compiled-a-branch`,
    pass: branches,
    note: branches ? "" : "no branch in the workflow",
  });
  console.log(`  ${branches ? "✅" : "❌"} ${task}/compiled-a-branch`);

  for (const set of recorded) {
    results.push(
      await replay(
        task,
        set,
        await expectedTriage(set),
        false,
        `${task}/same-data ${set}`,
      ),
    );
  }
  for (const set of ["triage-urgent-2", "triage-normal-2", "triage-spam-2"]) {
    results.push(
      await replay(
        task,
        set,
        await expectedTriage(set),
        false,
        `${task}/new-data ${set}`,
      ),
    );
  }
  // a path never recorded: drift, the agent does it, the workflow learns it
  results.push(
    await replay(
      task,
      "triage-billing",
      await expectedTriage("triage-billing"),
      true,
      `${task}/unseen-path triage-billing (falls back)`,
    ),
  );
  results.push(
    await replay(
      task,
      "triage-billing",
      await expectedTriage("triage-billing"),
      false,
      `${task}/unseen-path learned: triage-billing again, alone`,
    ),
  );
  results.push(
    await replay(
      task,
      "triage-urgent-2",
      await expectedTriage("triage-urgent-2"),
      false,
      `${task}/old path still works after learning`,
    ),
  );
  return results;
}

async function sweep(): Promise<Result[]> {
  const task = "inbox-sweep";
  await resetTask(task);
  await clearActions();
  const rec = await agent(task, "sweep-a");
  if (rec.code !== 0)
    throw new Error(`[${task}] agent run failed:\n${rec.output}`);
  console.log(`[${task}] recorded sweep-a`);
  const compiled = await hotpath(["compile", task, "--yes"], "sweep-a");
  if (compiled.code !== 0)
    throw new Error(`[${task}] compile failed:\n${compiled.output}`);
  const shown = await hotpath(["show", task], "sweep-a");
  const rule = /only if email\.category is "spam"/.test(shown.output);
  console.log(`  ${rule ? "✅" : "❌"} ${task}/learned-the-rule`);
  const out: Result[] = [
    {
      scenario: `${task}/learned-the-rule`,
      pass: rule,
      note: rule ? "" : shown.output.trim().slice(0, 300),
    },
  ];
  for (const [label, set] of [
    ["same-data", "sweep-a"],
    ["new-data", "sweep-b"],
  ] as const) {
    out.push(
      await replay(
        task,
        set,
        await expectedSweep(set),
        false,
        `${task}/${label} ${set}`,
      ),
    );
  }
  return out;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const all: Result[][] = [];
  for (let run = 1; run <= runs; run++) {
    console.log(`\n=== run ${run} of ${runs} ===`);
    const results: Result[] = [];
    for (const part of [triage, sweep]) {
      try {
        results.push(...(await part()));
      } catch (err) {
        const note = err instanceof Error ? err.message : String(err);
        results.push({ scenario: part.name, pass: false, note });
        console.log(`  ❌ ${part.name} — ${note.slice(0, 300)}`);
      }
    }
    all.push(results);
  }
  const names = [...new Set(all.flat().map((r) => r.scenario))];
  const width = Math.max(...names.map((n) => n.length));
  console.log("\nscenario".padEnd(width + 2) + "passed");
  for (const name of names) {
    const rows = all.flat().filter((r) => r.scenario === name);
    console.log(
      `${name.padEnd(width + 2)}${rows.filter((r) => r.pass).length}/${rows.length}`,
    );
  }
  await writeFile(
    path.join(repoRoot, "bench", "branching-results.json"),
    JSON.stringify({ at: new Date().toISOString(), runs: all }, null, 2),
  );
  const failed = all.flat().filter((r) => !r.pass).length;
  console.log(
    failed ? `\n❌ ${failed} check(s) failed` : "\n✅ all checks passed",
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
