// `hotpath scan <file-or-folder>`: what would Hotpath save on traces you
// already have? Reads exports from OpenTelemetry GenAI, LangSmith or Langfuse
// (or hotpath's own traces). Local only: no network, no model, no install in
// the agent. See docs/SCAN.md.
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { InvalidArgumentError, type Command } from "commander";
import {
  PRIVACY_LINE,
  formatScanHtml,
  formatScanJson,
  formatScanText,
  loadRuns,
  parsePriceArg,
  scanRuns,
  type ModelPrice,
} from "@hotpathrun/learn";

function positive(name: string, text: string): number {
  const v = Number(text);
  if (!Number.isFinite(v) || v <= 0)
    throw new InvalidArgumentError(`${name} must be a positive number`);
  return v;
}

export function addScanCommand(program: Command): void {
  program
    .command("scan <path>")
    .description(
      "Estimate what Hotpath would save on traces you already have (OTel GenAI, LangSmith, Langfuse); runs locally, sends nothing",
    )
    .option("--json", "print the result as JSON instead of the summary")
    .option("--html <file>", "also write a one-file HTML report")
    .option(
      "--days <n>",
      "days the traces cover (default: from the runs' times)",
      (v) => positive("--days", v),
    )
    .option(
      "--hot-after <n>",
      "clean runs of one path that make it compilable (default 3)",
      (v) => Math.round(positive("--hot-after", v)),
    )
    .option(
      "--price <model=in/out>",
      "list price for a model, USD per 1M tokens (repeatable), e.g. gpt-4.1=2/8",
      (v, prev: Record<string, ModelPrice>) => {
        try {
          const { model, price } = parsePriceArg(v);
          return { ...prev, [model]: price };
        } catch (err) {
          throw new InvalidArgumentError((err as Error).message);
        }
      },
      {} as Record<string, ModelPrice>,
    )
    .option(
      "--run-cost <usd>",
      "what one agent run costs, for traces with no usage numbers",
      (v) => positive("--run-cost", v),
    )
    .action(
      async (
        target: string,
        options: {
          json?: boolean;
          html?: string;
          days?: number;
          hotAfter?: number;
          price: Record<string, ModelPrice>;
          runCost?: number;
        },
      ) => {
        const { runs, skipped, filesRead } = await loadRuns(target);
        const result = scanRuns(runs, {
          days: options.days,
          hotAfter: options.hotAfter,
          prices: options.price,
          runCostUsd: options.runCost,
        });
        if (options.html) {
          await writeFile(options.html, formatScanHtml(result), "utf8");
        }
        if (options.json) {
          console.log(formatScanJson(result));
        } else {
          console.log(formatScanText(result));
          if (options.html)
            console.log(`\nReport written to ${path.resolve(options.html)}`);
        }
        const note = options.json ? console.error : console.log;
        if (skipped.length > 0) {
          note(
            `\nSkipped ${skipped.length} file${skipped.length === 1 ? "" : "s"} (read ${filesRead}):`,
          );
          for (const s of skipped.slice(0, 5)) note(`  ${s.file}: ${s.why}`);
        }
        if (options.json) console.error(PRIVACY_LINE);
      },
    );
}
