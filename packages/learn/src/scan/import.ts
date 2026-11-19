// Read what a team already has: one export file, or a folder of them. The
// format is found from the contents, not the file name.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { readTrace } from "@hotpathrun/shared";

import { importLangfuse, looksLikeLangfuse } from "./langfuse.js";
import { importLangSmith, looksLikeLangSmith } from "./langsmith.js";
import { importOtlp, looksLikeOtlp } from "./otlp.js";
import { ImportError, type ImportedRun } from "./types.js";

export type ExportFormat = "otlp" | "langsmith" | "langfuse";

export function detectFormat(json: unknown): ExportFormat | null {
  if (looksLikeOtlp(json)) return "otlp";
  if (looksLikeLangSmith(json)) return "langsmith";
  if (looksLikeLangfuse(json)) return "langfuse";
  return null;
}

/** Runs from one parsed JSON document, whichever of the three formats it is. */
export function importJson(json: unknown, where: string): ImportedRun[] {
  switch (detectFormat(json)) {
    case "otlp":
      return importOtlp(json);
    case "langsmith":
      return importLangSmith(json);
    case "langfuse":
      return importLangfuse(json);
    default:
      throw new ImportError(
        `${where}: not a format hotpath scan reads. Supported: an OTLP JSON export of OpenTelemetry GenAI spans, a LangSmith run export, a Langfuse export, or hotpath's own traces. See docs/SCAN.md for the export steps.`,
      );
  }
}

/** .jsonl: one JSON document per line (OTLP file exporters write this). */
function importLines(text: string, where: string): ImportedRun[] {
  const docs = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);
  if (docs.length > 0 && docs.every(looksLikeOtlp)) {
    return importOtlp({
      resourceSpans: docs.flatMap(
        (d) => (d as { resourceSpans: unknown[] }).resourceSpans,
      ),
    });
  }
  // one run or observation per line: read them as one list
  return importJson(docs, where);
}

async function importFile(file: string): Promise<ImportedRun[]> {
  const text = await readFile(file, "utf8");
  const where = path.basename(file);
  if (file.endsWith(".jsonl")) {
    const first = text.split("\n").find((l) => l.trim());
    if (first && /"type"\s*:\s*"meta"/.test(first)) {
      const trace = await readTrace(file, { allowOpen: true });
      return [{ source: "hotpath", id: where, trace, usage: null }];
    }
    return importLines(text, where);
  }
  try {
    return importJson(JSON.parse(text) as unknown, where);
  } catch (err) {
    if (err instanceof SyntaxError)
      throw new ImportError(`${where}: not valid JSON (${err.message})`);
    throw err;
  }
}

async function files(target: string): Promise<string[]> {
  const info = await stat(target);
  if (!info.isDirectory()) return [target];
  const out: string[] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...(await files(full)));
    else if (/\.jsonl?$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

export interface LoadResult {
  runs: ImportedRun[];
  /** files that could not be read, with why (never a file's contents) */
  skipped: Array<{ file: string; why: string }>;
  filesRead: number;
}

/** Every run in a file or folder. A bad file is skipped; a bad target throws. */
export async function loadRuns(target: string): Promise<LoadResult> {
  let list: string[];
  try {
    list = await files(target);
  } catch {
    throw new ImportError(
      `cannot read ${target}: give hotpath scan a trace export file or a folder of them`,
    );
  }
  const runs: ImportedRun[] = [];
  const skipped: LoadResult["skipped"] = [];
  let filesRead = 0;
  for (const file of list) {
    try {
      runs.push(...(await importFile(file)));
      filesRead++;
    } catch (err) {
      skipped.push({
        file: path.relative(process.cwd(), file) || file,
        why: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // a folder with nothing readable, or a file that is not an export, says so
  if (runs.length === 0 && skipped.length > 0 && list.length === 1) {
    throw new ImportError(skipped[0]!.why);
  }
  return { runs, skipped, filesRead };
}
