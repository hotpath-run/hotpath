import { describe, expect, it } from "vitest";

import { pathSignature } from "../src/index.js";

import { bankRun, unlabelledRun, withCalls } from "./helpers.js";

describe("pathSignature", () => {
  it("is the same for the same task on different data", () => {
    const a = pathSignature(unlabelledRun("morning-brief", "2026-10-01"));
    const b = pathSignature(unlabelledRun("morning-brief", "2026-11-17"));
    expect(a.key).toBe(b.key);
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^path-[0-9a-f]{8}$/);
  });

  it("is the same for a different number of pages and loop items", () => {
    const three = pathSignature(bankRun("2026-10-01", 3));
    const five = pathSignature(bankRun("2026-10-02", 5));
    const one = pathSignature(bankRun("2026-10-03", 1));
    expect(three.key).toBe(five.key);
    expect(one.key).toBe(three.key);
  });

  it("is the same when the agent looped over one item instead of two", () => {
    const run = bankRun("2026-10-01", 2);
    const oneFx = withCalls(
      run,
      run.calls.filter(
        (c) => !(c.tool === "get_fx_rate" && c.args.currency === "GBP"),
      ),
    );
    expect(pathSignature(oneFx).key).toBe(pathSignature(run).key);
  });

  it("is the same when a failed call was retried", () => {
    const run = unlabelledRun("morning-brief", "2026-10-01");
    const [first, ...rest] = run.calls;
    const retried = withCalls(run, [
      { ...first!, isError: true, result: "503 Service Unavailable" },
      first!,
      ...rest,
    ]);
    expect(pathSignature(retried).key).toBe(pathSignature(run).key);
  });

  it("differs for a different tool order", () => {
    const run = unlabelledRun("morning-brief", "2026-10-01");
    const [a, b, ...rest] = run.calls;
    const swapped = withCalls(run, [b!, a!, ...rest]);
    expect(pathSignature(swapped).key).not.toBe(pathSignature(run).key);
  });

  it("differs for a different side effect", () => {
    const run = unlabelledRun("morning-brief", "2026-10-01");
    const other = {
      ...run,
      meta: {
        ...run.meta,
        tools: [
          ...run.meta.tools,
          { name: "post_slack", inputSchema: { type: "object" } },
        ],
      },
    };
    const slack = withCalls(
      other,
      run.calls.map((c) =>
        c.tool === "send_message" ? { ...c, tool: "post_slack" } : c,
      ),
    );
    expect(pathSignature(slack).key).not.toBe(pathSignature(run).key);
    // a side effect left out is a different path too
    const none = withCalls(
      run,
      run.calls.filter((c) => c.tool !== "send_message"),
    );
    expect(pathSignature(none).key).not.toBe(pathSignature(run).key);
  });

  it("marks side effects and where each argument comes from", () => {
    const sig = pathSignature(bankRun("2026-10-01", 2));
    expect(sig.steps).toEqual([
      "list_bank_lines(date:value, page:page)",
      "list_ledger(date:value)",
      "get_fx_rate(currency:result)*",
      "send_message!(text:text, to:value)",
    ]);
  });
});
