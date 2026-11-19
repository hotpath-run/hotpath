import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileTrace } from "@hotpathrun/compiler";
import { DriftError, runWorkflow } from "@hotpathrun/runtime";
import { mentions, readTrace } from "@hotpathrun/shared";

// `pnpm bench:replay [--runs N]`: what the AI step costs in a replay, with the
// list rows written by code (the default) and without (HOTPATH_LAYOUT=0).
// One workflow, compiled from the checked-in morning-brief recording, is
// replayed N times on the recorded data and on new data in each mode. Dry
// runs: nothing is sent. Real model calls (the replay model only): set
// HOTPATH_CHEAP_REASONING=default to measure a model that thinks.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const argv = process.argv.slice(2);
const runs = argv.includes("--runs")
  ? Number(argv[argv.indexOf("--runs") + 1])
  : 5;
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error("--runs needs a positive integer, e.g. --runs 5");
}

interface Sample {
  ok: boolean;
  complete: boolean;
  filled: boolean;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  llmMs: number;
  note?: string;
}

const mean = (xs: number[]) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

async function main(): Promise<void> {
  const trace = await readTrace(
    path.join(repoRoot, "packages/compiler/test/fixtures/morning-brief.jsonl"),
  );
  const workflow = compileTrace(trace, "fixtures/morning-brief.jsonl");
  // the built demo server, started with plain node
  workflow.serverArgv = [
    process.execPath,
    path.join(repoRoot, "examples/demo-tools/dist/index.js"),
  ];
  process.env.HOTPATH_REUSE = "0"; // every replay asks the model

  const cases = [
    { data: "same data", fixtures: "default" },
    { data: "new data", fixtures: "new-data" },
  ];
  const rows: string[][] = [];
  const realLog = console.log;

  for (const { data, fixtures } of cases) {
    const expected = JSON.parse(
      await readFile(
        path.join(
          repoRoot,
          "examples/demo-tools/fixtures",
          fixtures,
          "expected.json",
        ),
        "utf8",
      ),
    ) as { date: string; mustMention: string[] };
    for (const mode of ["whole text", "rows by code"]) {
      process.env.DEMO_FIXTURES = fixtures;
      process.env.HOTPATH_LAYOUT = mode === "whole text" ? "0" : "1";
      const samples: Sample[] = [];
      for (let i = 0; i < runs; i++) {
        let sent = "";
        console.log = (...args: unknown[]) => {
          const line = args.join(" ");
          if (line.startsWith("dry-run:")) {
            sent =
              (JSON.parse(line.slice(line.indexOf("{"))) as { text?: string })
                .text ?? "";
          }
        };
        try {
          const m = await runWorkflow(workflow, {
            inputs: { date: expected.date },
            dryRun: true,
          });
          samples.push({
            ok: true,
            complete: expected.mustMention.every((v) => mentions(sent, v)),
            filled: (m.filledSteps ?? []).length > 0,
            llmCalls: m.llmCalls,
            promptTokens: m.promptTokens,
            completionTokens: m.completionTokens,
            llmMs: m.llmMs,
          });
        } catch (err) {
          if (!(err instanceof DriftError)) throw err;
          samples.push({
            ok: false,
            complete: false,
            filled: false,
            llmCalls: err.metrics.llmCalls,
            promptTokens: err.metrics.promptTokens,
            completionTokens: err.metrics.completionTokens,
            llmMs: err.metrics.llmMs,
            note: err.reason.slice(0, 80),
          });
        } finally {
          console.log = realLog;
        }
        const s = samples.at(-1)!;
        console.log(
          `${data} / ${mode} / run ${i + 1}: ${s.completionTokens} output tokens, ` +
            `${(s.llmMs / 1000).toFixed(1)}s, ${s.llmCalls} call${s.llmCalls === 1 ? "" : "s"}` +
            `${s.ok ? "" : ` DRIFT (${s.note})`}${s.ok && !s.complete ? " INCOMPLETE" : ""}` +
            `${mode === "rows by code" && s.ok && !s.filled ? " (model wrote the lists itself)" : ""}`,
        );
      }
      rows.push([
        data,
        mode,
        `${samples.filter((s) => s.ok && s.complete).length}/${runs}`,
        mean(samples.map((s) => s.completionTokens)).toFixed(0),
        `${Math.min(...samples.map((s) => s.completionTokens))}–${Math.max(...samples.map((s) => s.completionTokens))}`,
        mean(samples.map((s) => s.promptTokens)).toFixed(0),
        (mean(samples.map((s) => s.llmMs)) / 1000).toFixed(1),
        mean(samples.map((s) => s.llmCalls)).toFixed(1),
        mode === "rows by code"
          ? `${samples.filter((s) => s.filled).length}/${runs}`
          : "-",
      ]);
    }
  }

  const header = [
    "data",
    "AI step writes",
    "passed",
    "output tokens (mean)",
    "range",
    "prompt tokens",
    "llm s (mean)",
    "calls",
    "rows filled",
  ];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(
    `\nmodel ${process.env.HOTPATH_CHEAP_MODEL ?? "(default)"}, ` +
      `thinking ${process.env.HOTPATH_CHEAP_REASONING || "none"}, ${runs} runs each`,
  );
  console.log([line(header), ...rows.map(line)].join("\n"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
