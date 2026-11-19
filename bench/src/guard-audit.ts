import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileTraceDetailed } from "@hotpathrun/compiler";
import { checkGrounding, checkLlmGuard, checkStale } from "@hotpathrun/runtime";
import { readTrace, type TemplateContext } from "@hotpathrun/shared";

// `pnpm bench:guard-audit [task …]`
//
// Is the grounding guard as safe as it was? For every AI step of a recorded
// task, built twice (old per-position grounding, HOTPATH_RELAX_GROUNDING=0, and
// the current one): take a text that contains every value of the data the step
// read (the guard must accept it), then leave out ONE value at a time and ask
// the guard whether it notices. A value whose omission the old guard caught and
// the new one does not is a loss of safety; one the new guard catches and the
// old one did not is a gain. No model is called.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

type Leaf = { text: string; key: string };

function leaves(node: unknown, prefix: string, out: Leaf[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => leaves(v, `${prefix}.${i}`, out));
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) leaves(v, `${prefix}.${k}`, out);
  } else if (
    typeof node === "string" ||
    (typeof node === "number" && Number.isFinite(node))
  ) {
    out.push({ text: String(node), key: prefix });
  }
}

interface Row {
  task: string;
  step: string;
  leaves: number;
  acceptedFull: [boolean, boolean];
  caught: [number, number];
  lost: string[];
  gained: string[];
  /** the same, leaving out a whole list item (all its values) at a time */
  itemsCaught: [number, number];
  items: number;
  itemsLost: string[];
}

async function audit(task: string, traceFile: string): Promise<Row[]> {
  const trace = await readTrace(traceFile, { allowOpen: true });
  const rows: Row[] = [];
  const build = (relax: boolean) => {
    if (relax) delete process.env.HOTPATH_RELAX_GROUNDING;
    else process.env.HOTPATH_RELAX_GROUNDING = "0";
    try {
      return compileTraceDetailed(trace, "audit");
    } finally {
      delete process.env.HOTPATH_RELAX_GROUNDING;
    }
  };
  const oldBuild = build(false);
  const newBuild = build(true);
  for (const step of newBuild.workflow.steps) {
    if (step.type !== "llm") continue;
    const oldStep = oldBuild.workflow.steps.find((s) => s.id === step.id);
    if (!oldStep || oldStep.type !== "llm") continue;
    // the data the step read: the recording's own results
    const ctx: TemplateContext = { inputs: trace.meta.inputs, steps: {} };
    const all: Leaf[] = [];
    for (const r of newBuild.recorded) {
      ctx.steps[r.id] = (
        r.field === "results" ? { results: r.result } : { result: r.result }
      ) as never;
      leaves(r.result, `${r.id}`, all);
    }
    const verdict = (guard: typeof step.guard, text: string, todayItems = 0) =>
      checkLlmGuard(guard, text, todayItems) === null &&
      checkGrounding(guard.grounding, ctx, text).length === 0 &&
      checkStale(guard.exampleFacts, ctx, text).length === 0;
    const text = all.map((l) => l.text).join("\n");
    const acceptedFull: [boolean, boolean] = [
      verdict(oldStep.guard, text),
      verdict(step.guard, text),
    ];
    let caughtOld = 0;
    let caughtNew = 0;
    const lost: string[] = [];
    const gained: string[] = [];
    all.forEach((leaf, i) => {
      const without = all
        .filter((_, j) => j !== i)
        .map((l) => l.text)
        .join("\n")
        // other values that contain this one would hide its omission
        .split(leaf.text)
        .join("");
      const noticedOld = !verdict(oldStep.guard, without);
      const noticedNew = !verdict(step.guard, without);
      if (noticedOld) caughtOld++;
      if (noticedNew) caughtNew++;
      const label = `${leaf.key} = ${leaf.text.slice(0, 40)}`;
      if (noticedOld && !noticedNew) lost.push(label);
      if (!noticedOld && noticedNew) gained.push(label);
    });
    // whole items: every value of one list element left out together
    const prefixes = new Set<string>();
    for (const l of all) {
      const parts = l.key.split(".");
      for (let i = 1; i < parts.length; i++) {
        if (/^\d+$/.test(parts[i]!))
          prefixes.add(parts.slice(0, i + 1).join("."));
      }
    }
    let itemsOld = 0;
    let itemsNew = 0;
    const itemsLost: string[] = [];
    for (const prefix of prefixes) {
      const mine = all.filter((l) => l.key.startsWith(`${prefix}.`));
      if (mine.length === 0) continue;
      let without = all
        .filter((l) => !l.key.startsWith(`${prefix}.`))
        .map((l) => l.text)
        .join("\n");
      for (const m of mine) without = without.split(m.text).join("");
      const noticedOld = !verdict(oldStep.guard, without);
      const noticedNew = !verdict(step.guard, without);
      if (noticedOld) itemsOld++;
      if (noticedNew) itemsNew++;
      if (noticedOld && !noticedNew)
        itemsLost.push(`${prefix} (${mine[0]!.text.slice(0, 30)})`);
    }
    rows.push({
      task,
      step: step.id,
      leaves: all.length,
      acceptedFull,
      caught: [caughtOld, caughtNew],
      lost,
      gained,
      itemsCaught: [itemsOld, itemsNew],
      items: prefixes.size,
      itemsLost,
    });
  }
  return rows;
}

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const jobs: Array<[string, string]> = [];
  jobs.push([
    "morning-brief (checked-in recording)",
    path.join(repoRoot, "packages/compiler/test/fixtures/morning-brief.jsonl"),
  ]);
  const tracesDir = path.join(repoRoot, "traces");
  for (const task of (await readdir(tracesDir)).sort()) {
    if (/^(idle|m3-|m6-)/.test(task)) continue;
    if (only.length > 0 && !only.includes(task)) continue;
    const files = (await readdir(path.join(tracesDir, task)))
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    if (files.length === 0) continue;
    jobs.push([task, path.join(tracesDir, task, files.at(-1)!)]);
  }
  let lostTotal = 0;
  let itemsLostTotal = 0;
  const sum = {
    steps: 0,
    values: [0, 0],
    items: [0, 0],
    allValues: 0,
    allItems: 0,
  };
  let gainedTotal = 0;
  console.log(
    "task / step".padEnd(46) +
      "values  full text accepted (old/new)  omissions caught (old/new)  lost  gained",
  );
  for (const [task, file] of jobs) {
    let rows: Row[];
    try {
      rows = await audit(task, file);
    } catch (err) {
      console.log(`${task}: skipped (${(err as Error).message.slice(0, 60)})`);
      continue;
    }
    for (const r of rows) {
      lostTotal += r.lost.length;
      itemsLostTotal += r.itemsLost.length;
      sum.steps++;
      sum.values[0]! += r.caught[0];
      sum.values[1]! += r.caught[1];
      sum.items[0]! += r.itemsCaught[0];
      sum.items[1]! += r.itemsCaught[1];
      sum.allValues += r.leaves;
      sum.allItems += r.items;
      gainedTotal += r.gained.length;
      console.log(
        `${`${r.task} / ${r.step}`.padEnd(46)}${String(r.leaves).padEnd(8)}` +
          `${`${r.acceptedFull[0]}/${r.acceptedFull[1]}`.padEnd(26)}` +
          `${`${r.caught[0]}/${r.caught[1]}`.padEnd(29)}` +
          `${String(r.lost.length).padEnd(6)}${r.gained.length}`,
      );
      if (r.items > 0) {
        console.log(
          `    whole items left out: caught ${r.itemsCaught[0]}/${r.itemsCaught[1]} of ${r.items} (old/new)`,
        );
      }
      for (const l of r.lost) console.log(`    LOST   ${l}`);
      for (const l of r.itemsLost) console.log(`    LOST ITEM ${l}`);
      for (const g of r.gained.slice(0, 4)) console.log(`    GAINED ${g}`);
    }
  }
  console.log(
    `
${sum.steps} AI steps. Values left out one at a time (of ${sum.allValues}): old guard caught ${sum.values[0]}, new ${sum.values[1]}. ` +
      `Whole items left out (of ${sum.allItems}): old ${sum.items[0]}, new ${sum.items[1]}.`,
  );
  console.log(
    `\nomissions the old guard caught and the new one misses: ${lostTotal}; ` +
      `the other way round: ${gainedTotal}; whole items the old guard caught and the new one misses: ${itemsLostTotal}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
