import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pruneTraces, retainDays } from "../src/retention.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hp-retain-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
async function trace(name: string, ageDays: number, now: number) {
  const file = path.join(dir, name);
  await writeFile(file, "{}");
  const t = new Date(now - ageDays * DAY);
  await utimes(file, t, t);
}

describe("trace retention (security finding 7)", () => {
  it("is off unless HOTPATH_RETAIN_DAYS is a positive number", () => {
    expect(retainDays({})).toBeNull();
    expect(retainDays({ HOTPATH_RETAIN_DAYS: "0" })).toBeNull();
    expect(retainDays({ HOTPATH_RETAIN_DAYS: "x" })).toBeNull();
    expect(retainDays({ HOTPATH_RETAIN_DAYS: "30" })).toBe(30);
  });

  it("deletes old traces but never the one the workflow came from", async () => {
    const now = Date.now();
    await trace("old.jsonl", 40, now);
    await trace("compiled-from.jsonl", 90, now);
    await trace("recent.jsonl", 2, now);
    await writeFile(path.join(dir, "notes.txt"), "keep");
    const gone = await pruneTraces(dir, "compiled-from.jsonl", 30, now);
    expect(gone).toEqual(["old.jsonl"]);
    expect((await readdir(dir)).sort()).toEqual([
      "compiled-from.jsonl",
      "notes.txt",
      "recent.jsonl",
    ]);
  });

  it("does nothing when the task has no traces", async () => {
    expect(await pruneTraces(path.join(dir, "none"), "x", 1)).toEqual([]);
  });
});
