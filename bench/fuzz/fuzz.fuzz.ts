// pnpm fuzz                       200 cases (seeds 1..200)
// FUZZ_RUNS=5000 pnpm fuzz        more
// FUZZ_FROM=5001 pnpm fuzz       seeds from 5001 (fresh cases nobody tuned for)
// FUZZ_SEED=1234 pnpm fuzz        one case, with full detail
// FUZZ_KIND=digest FUZZ_MUTATION=longer pnpm fuzz   only those
// Writes out/fuzz-report.json. Never calls a model: chat() answers with the
// fuzzer's fake model, which only mentions what its prompt shows.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@hotpathrun/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hotpathrun/shared")>();
  const { model } = await import("../src/fuzz/model.js");
  return {
    ...actual,
    chat: vi.fn(async (options: { messages: Array<{ content?: unknown }> }) => {
      const prompt = options.messages
        .map((m) =>
          typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        )
        .join("\n");
      const text = model.answer(prompt);
      return {
        text,
        toolCalls: [],
        promptTokens: Math.ceil(prompt.length / 4),
        completionTokens: Math.ceil(text.length / 4),
        llmCalls: 1,
      };
    }),
  };
});

import { runCase, type CaseResult } from "../src/fuzz/run.js";
import type { Kind, Mutation } from "../src/fuzz/world.js";

process.env.HOTPATH_JOURNAL = "0";

process.env.HOTPATH_REUSE = "0";

const BAD = new Set([
  "contradicts-recording",
  "stops-on-own-recording",
  "silent-wrong",
  "wrong-then-stopped",
  "crash",
  "compile-crash",
]);

describe("fuzz", () => {
  it("replays generated workflows on mutated data", async () => {
    const one = process.env.FUZZ_SEED
      ? Number(process.env.FUZZ_SEED)
      : undefined;
    const runs = Number(process.env.FUZZ_RUNS ?? 200);
    const only = {
      kind: process.env.FUZZ_KIND as Kind | undefined,
      mutation: process.env.FUZZ_MUTATION as Mutation | undefined,
    };
    const seeds =
      one !== undefined
        ? [one]
        : Array.from(
            { length: runs },
            (_, i) => i + Number(process.env.FUZZ_FROM ?? 1),
          );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const results: CaseResult[] = [];
    try {
      for (const seed of seeds) results.push(await runCase(seed, only));
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }

    // counts per kind × mutation × outcome
    const table = new Map<string, number>();
    for (const r of results) {
      const key = `${r.kind.padEnd(10)} ${r.mutation.padEnd(13)} ${r.outcome}`;
      table.set(key, (table.get(key) ?? 0) + 1);
    }
    const bad = results.filter((r) => BAD.has(r.outcome));
    // a stop on a harmless change makes the agent run for nothing: count it
    const harmless = new Set(["fresh", "extra-fields", "null-field"]);
    const falseStops = results.filter(
      (r) =>
        r.outcome === "stopped" &&
        harmless.has(r.mutation) &&
        // a customer giving what no recording had is a new path: stopping is right
        !r.detail?.includes("which no recording had"),
    );
    const lines = [
      `${results.length} cases: ${results.filter((r) => r.outcome === "ok").length} ok, ` +
        `${results.filter((r) => r.outcome === "stopped").length} stopped safely ` +
        `(${falseStops.length} on harmless changes), ${bad.length} bad`,
      ...[...table.entries()]
        .filter(([k]) => !k.endsWith(" ok"))
        .sort()
        .map(([k, n]) => `  ${String(n).padStart(4)}  ${k}`),
      ...[...bad]
        .sort(
          (a, b) => [...BAD].indexOf(a.outcome) - [...BAD].indexOf(b.outcome),
        )
        .slice(0, Number(process.env.FUZZ_SHOW ?? 12))
        .map(
          (r) =>
            `\nseed ${r.seed} ${r.kind}/${r.mutation} (${r.recordings} recordings): ${r.outcome}` +
            (r.detail ? `\n  ${r.detail.slice(0, 300)}` : "") +
            (r.workflow ? `\n  workflow: ${r.workflow.slice(0, 400)}` : "") +
            (r.expected
              ? `\n  expected: ${JSON.stringify(r.expected).slice(0, 300)}`
              : "") +
            (r.actual
              ? `\n  actual:   ${JSON.stringify(r.actual).slice(0, 300)}`
              : ""),
        ),
    ];
    console.log(lines.join("\n"));
    const out = path.resolve(import.meta.dirname, "../../out");
    await mkdir(out, { recursive: true });
    await writeFile(
      path.join(out, "fuzz-report.json"),
      JSON.stringify(results, null, 2),
    );

    if (process.env.FUZZ_STRICT === "1") expect(bad).toEqual([]);
  }, 3_600_000);
});
