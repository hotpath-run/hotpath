// A run killed between two actions, then run again with the same inputs: the
// first action must not happen twice (B5 of the v1 brief).
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { Journal } from "../src/journal.js";
import { runWorkflow, type ToolBackend } from "../src/runtime.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const TASK = "crash-safety-test";
const journalDir = path.join(repoRoot, ".hotpath", "journal", TASK);
afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true });
  await rm(path.join(repoRoot, ".hotpath", "answers", `${TASK}.json`), {
    force: true,
  });
});

const action = (id: string, to: string, repeatable = false) => ({
  id,
  type: "tool" as const,
  tool: "send_message",
  args: { to, text: "invoice paid" },
  sideEffect: true,
  ...(repeatable ? { repeatable: true } : {}),
  guard: {},
});
const workflow = (repeatable = false) =>
  ({
    task: TASK,
    server: "in-process",
    inputs: { date: { example: "2026-10-02" } },
    steps: [action("s1", "accounting"), action("s2", "customer", repeatable)],
  }) as never;

/** Counts sends; `dieAt` throws like a killed process at that recipient. */
function tools(dieAt?: string) {
  const sent: string[] = [];
  const backend: ToolBackend = {
    async call(_tool, args) {
      if (args.to === dieAt) throw new Error("process killed");
      sent.push(String(args.to));
      return { value: { ok: true, to: args.to }, isError: false };
    },
  };
  return { sent, backend };
}
const inputs = { date: "2026-10-02" };

describe("crash between two actions", () => {
  it("a run killed right after the first action does not repeat it", async () => {
    // the state a kill between the two actions leaves: s1 done, s2 never started
    const j = await Journal.open(journalDir, TASK, inputs);
    await j.started("s1");
    await j.finished("s1", { ok: true, to: "accounting" });

    const rerun = tools();
    const metrics = await runWorkflow(workflow(), {
      inputs,
      tools: rerun.backend,
    });
    expect(rerun.sent).toEqual(["customer"]); // s2 once, s1 not again
    expect(metrics.resumedActions).toEqual(["s1"]);

    // the run finished: the next one with these inputs acts again
    const next = tools();
    await runWorkflow(workflow(), { inputs, tools: next.backend });
    expect(next.sent).toEqual(["accounting", "customer"]);
  });

  it("a run killed during the second action stops instead of guessing", async () => {
    const first = tools("customer");
    await expect(
      runWorkflow(workflow(), { inputs, tools: first.backend }),
    ).rejects.toThrow(/process killed/);
    expect(first.sent).toEqual(["accounting"]);

    // s2 was started and never confirmed: it may have gone out
    const rerun = tools();
    const err = await runWorkflow(workflow(), {
      inputs,
      tools: rerun.backend,
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(
      /never confirmed, so it may already have happened/,
    );
    expect((err as { sideEffectRan: boolean }).sideEffectRan).toBe(true);
    expect(rerun.sent).toEqual([]); // neither action repeated
  });

  it("an action marked repeatable is done again", async () => {
    const first = tools("customer");
    await runWorkflow(workflow(true), { inputs, tools: first.backend }).catch(
      () => undefined,
    );
    const rerun = tools();
    await runWorkflow(workflow(true), { inputs, tools: rerun.backend });
    expect(rerun.sent).toEqual(["customer"]);
  });

  it("other inputs are another run", async () => {
    const first = tools("customer");
    await runWorkflow(workflow(), { inputs, tools: first.backend }).catch(
      () => undefined,
    );
    const other = tools();
    await runWorkflow(workflow(), {
      inputs: { date: "2026-10-03" },
      tools: other.backend,
    });
    expect(other.sent).toEqual(["accounting", "customer"]);
  });
});
