import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { idempotencyKey, inputsKey, Journal } from "../src/journal.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hp-journal-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Journal", () => {
  it("remembers a finished action of a run that did not finish", async () => {
    const first = await Journal.open(dir, "t", { date: "2026-10-02" });
    await first.started("s6");
    await first.finished("s6", { ok: true, id: "m1" });
    // crash: close() is never called

    const rerun = await Journal.open(dir, "t", { date: "2026-10-02" });
    expect(rerun.done("s6")).toEqual({ result: { ok: true, id: "m1" } });
    expect(rerun.unconfirmed("s6")).toBe(false);
  });

  it("flags an action that started and never confirmed", async () => {
    const first = await Journal.open(dir, "t", { date: "2026-10-02" });
    await first.started("s6");
    const rerun = await Journal.open(dir, "t", { date: "2026-10-02" });
    expect(rerun.done("s6")).toBeNull();
    expect(rerun.unconfirmed("s6")).toBe(true);
  });

  it("starts fresh after a run that finished", async () => {
    const first = await Journal.open(dir, "t", { date: "2026-10-02" });
    await first.finished("s6", {});
    await first.close();
    const next = await Journal.open(dir, "t", { date: "2026-10-02" });
    expect(next.done("s6")).toBeNull();
  });

  it("keeps runs with other inputs apart", async () => {
    const a = await Journal.open(dir, "t", { date: "2026-10-02" });
    await a.finished("s6", {});
    const b = await Journal.open(dir, "t", { date: "2026-10-03" });
    expect(b.done("s6")).toBeNull();
  });

  it("carries finished actions through a second crash", async () => {
    const first = await Journal.open(dir, "t", { d: "1" });
    await first.finished("s5", { id: 1 });
    const second = await Journal.open(dir, "t", { d: "1" });
    await second.started("s6"); // crashes again, before confirming s6
    const third = await Journal.open(dir, "t", { d: "1" });
    expect(third.done("s5")).toEqual({ result: { id: 1 } });
    expect(third.unconfirmed("s6")).toBe(true);
  });
});

describe("keys", () => {
  it("does not depend on the order of inputs", () => {
    expect(inputsKey("t", { a: "1", b: "2" })).toBe(
      inputsKey("t", { b: "2", a: "1" }),
    );
    expect(inputsKey("t", { a: "1" })).not.toBe(inputsKey("u", { a: "1" }));
  });
  it("gives each action of a run its own stable idempotency key", () => {
    const k = inputsKey("t", { a: "1" });
    expect(idempotencyKey(k, "s5")).toBe(idempotencyKey(k, "s5"));
    expect(idempotencyKey(k, "s5")).not.toBe(idempotencyKey(k, "s6"));
  });
});
