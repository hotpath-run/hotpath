// `hotpath compile --strict` refuses a recording the compiler warns about, so a
// script (or the bench) can record again instead of keeping a weak workflow.
import crossSpawn from "cross-spawn";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const task = `strict-${Date.now()}`;
const workflowFile = path.join(repoRoot, "workflows", `${task}.json`);
let dir: string;

function hotpath(
  args: string[],
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(
      process.execPath,
      ["--import", "tsx", "packages/cli/src/index.ts", ...args],
      { cwd: repoRoot },
    );
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** A recording whose message covers every email, or only the first. */
async function recording(name: string, text: string): Promise<string> {
  const lines = [
    {
      type: "meta",
      version: 1,
      task,
      startedAt: "2026-10-01T08:00:00Z",
      server: "node tools.js",
      inputs: { date: "2026-10-01" },
      tools: [
        {
          name: "get_emails",
          inputSchema: {},
          annotations: { readOnlyHint: true },
        },
        { name: "send_message", inputSchema: {} },
      ],
    },
    {
      type: "tool_call",
      seq: 1,
      tool: "get_emails",
      args: { date: "2026-10-01" },
      result: {
        emails: [
          { subject: "Q3 budget review moved" },
          { subject: "Team offsite agenda" },
          { subject: "Metro line 4 closed" },
        ],
      },
      isError: false,
      startedAt: "2026-10-01T08:00:01Z",
      durationMs: 5,
    },
    {
      type: "tool_call",
      seq: 2,
      tool: "send_message",
      args: { to: "me", text },
      result: { ok: true },
      isError: false,
      startedAt: "2026-10-01T08:00:02Z",
      durationMs: 5,
    },
    { type: "end", endedAt: "2026-10-01T08:00:03Z", toolCalls: 2 },
  ];
  const file = path.join(dir, name);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hotpath-strict-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(workflowFile, { force: true });
});

describe("hotpath compile --strict", () => {
  it("refuses a recording that left items out: exit 1, nothing written", async () => {
    const weak = await recording(
      "weak.jsonl",
      "Morning brief for today.\nEmails: Q3 budget review moved, and two more.",
    );
    const result = await hotpath([
      "compile",
      task,
      "--trace",
      weak,
      "--strict",
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("mentions 1 of 3 emails");
    expect(result.out).toContain("not compiled (--strict)");
    expect(result.out).toContain("Record the task again");
    expect(existsSync(workflowFile)).toBe(false);

    // without --strict the same recording compiles, with the warning
    const lenient = await hotpath(["compile", task, "--trace", weak]);
    expect(lenient.code).toBe(0);
    expect(lenient.out).toContain("⚠");
    expect(existsSync(workflowFile)).toBe(true);
  }, 60_000);

  it("accepts a recording that covers everything", async () => {
    const good = await recording(
      "good.jsonl",
      "Morning brief for today.\nEmails: Q3 budget review moved; Team offsite agenda; Metro line 4 closed.",
    );
    const result = await hotpath([
      "compile",
      task,
      "--trace",
      good,
      "--strict",
    ]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("compiled 3 steps");
    expect(result.out).not.toContain("⚠");
  }, 60_000);
});
