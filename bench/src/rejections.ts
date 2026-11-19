import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  guardOf,
  reportProblems,
  verdictOf,
  type Expectation,
  type MeasuredRun,
  type Verdict,
} from "./rejections-lib.js";

// `tsx bench/src/rejections.ts out/measure-<id>.jsonl [more.jsonl…]`
//
// Reads bench:measure records (run with HOTPATH_KEEP_REJECTED=1) and prints,
// per task: how many replays finished, and for each one a guard stopped, the
// step, the guard, its reason and whether the rejected text was really wrong.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SETS: Record<string, string> = {
  "same-data": "default",
  "new-data": "new-data",
  drift: "drift",
};

async function expectedFor(task: string, scenario: string) {
  const set = SETS[scenario] ?? "default";
  const file = path.join(
    repoRoot,
    "examples/demo-tools/fixtures",
    set,
    task === "morning-brief" ? "expected.json" : `${task}.expected.json`,
  );
  return JSON.parse(await readFile(file, "utf8")) as Expectation;
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    throw new Error(
      "name the records: tsx bench/src/rejections.ts out/measure-<id>.jsonl",
    );
  }
  const runs: MeasuredRun[] = [];
  for (const f of files) {
    for (const line of (await readFile(f, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as MeasuredRun & { kind?: string };
      if (!r.kind) runs.push(r);
    }
  }
  const counts = new Map<string, Record<Verdict, number>>();
  const detail: string[] = [];
  for (const run of runs) {
    const expected = await expectedFor(run.task, run.scenario);
    const v = verdictOf(run, expected);
    const key = `${run.task} ${run.scenario}`;
    const c =
      counts.get(key) ??
      ({
        "finished-correct": 0,
        "finished-wrong": 0,
        "true-rejection": 0,
        "false-rejection": 0,
        "provider-error": 0,
        unknown: 0,
      } as Record<Verdict, number>);
    c[v]++;
    counts.set(key, c);
    if (v === "finished-correct") continue;
    const reason = run.reason ?? run.driftReason ?? "";
    const last = run.rejectedOutputs?.at(-1) ?? run.sent;
    const problems = reportProblems(last, expected);
    detail.push(
      `| ${run.task} #${run.seq} | ${run.driftStep ?? "-"} | ${v === "finished-wrong" ? "none (finished)" : guardOf(reason)} | ${reason.slice(0, 140).replace(/\|/g, "/")} | ${v} | ${problems.join("; ").replace(/\|/g, "/") || "-"} |`,
    );
  }
  console.log(
    "| task / scenario | runs | finished correct | finished wrong | true rejections | false rejections | provider errors | unknown |",
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [key, c] of counts) {
    const n = Object.values(c).reduce((a, b) => a + b, 0);
    console.log(
      `| ${key} | ${n} | ${c["finished-correct"]} | ${c["finished-wrong"]} | ${c["true-rejection"]} | ${c["false-rejection"]} | ${c["provider-error"]} | ${c.unknown} |`,
    );
  }
  if (detail.length > 0) {
    console.log(
      "\n| run | step | guard | reason | verdict | what the rejected text got wrong |",
    );
    console.log("| --- | --- | --- | --- | --- | --- |");
    console.log(detail.join("\n"));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
