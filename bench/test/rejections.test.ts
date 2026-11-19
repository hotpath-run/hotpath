import { describe, expect, it } from "vitest";

import {
  guardOf,
  isProviderError,
  verdictOf,
  type MeasuredRun,
} from "../src/rejections-lib.js";

const expected = {
  mustMention: ["BK-2002", "428"],
  exact: { total: { value: -428 } },
};
const base: MeasuredRun = {
  seq: 1,
  task: "bank-reconciliation",
  scenario: "new-data",
  ok: false,
  sent: "",
  mentionsMissing: [],
  correctnessProblems: [],
};

describe("verdictOf", () => {
  it("calls a rejection false when the rejected text was a correct report", () => {
    const run = {
      ...base,
      reason: "llm output does not mention: BK-2003 (grounding guard)",
      rejectedOutputs: ["BK-2002 -108 EUR\nTotal: -428 EUR"],
    };
    expect(verdictOf(run, expected)).toBe("false-rejection");
  });

  it("calls a rejection true when the rejected text was wrong", () => {
    const run = {
      ...base,
      reason: "llm output does not mention: BK-2002 (grounding guard)",
      rejectedOutputs: ["Total: -332 EUR"],
    };
    expect(verdictOf(run, expected)).toBe("true-rejection");
  });

  it("never counts a provider error against the guards", () => {
    const run = { ...base, driftReason: "Error: 429 Resource exhausted" };
    expect(verdictOf(run, expected)).toBe("provider-error");
  });

  it("tells finished reports apart by correctness", () => {
    expect(verdictOf({ ...base, ok: true }, expected)).toBe("finished-correct");
    expect(
      verdictOf(
        { ...base, ok: true, correctnessProblems: ["total is 332"] },
        expected,
      ),
    ).toBe("finished-wrong");
  });
});

describe("guardOf / isProviderError", () => {
  it("names the guard from its reason", () => {
    expect(guardOf("llm output does not mention: x (grounding guard)")).toBe(
      "grounding",
    );
    expect(guardOf("llm output is 900 chars, exceeds maxChars 522")).toBe(
      "length",
    );
    expect(guardOf("repeats facts … (stale-fact guard)")).toBe("stale-fact");
  });
  it("spots provider failures", () => {
    expect(isProviderError("503 Service Unavailable")).toBe(true);
    expect(isProviderError("does not mention: 503 Main St")).toBe(true);
    expect(isProviderError("does not mention: BK-2002")).toBe(false);
  });
});

describe("isModelProviderFailure", () => {
  it("counts the model API failing, not a tool that answered 503", async () => {
    const { isModelProviderFailure } = await import("../src/rejections-lib.js");
    expect(
      isModelProviderFailure(
        "agent run failed: 429 Resource has been exhausted",
      ),
    ).toBe(true);
    expect(
      isModelProviderFailure("503 Service Unavailable from the model endpoint"),
    ).toBe(true);
    expect(
      isModelProviderFailure(
        "drift at s1: tool get_sales returned an error: 503 try again",
      ),
    ).toBe(false);
    expect(
      isModelProviderFailure(
        "llm output does not mention: x (grounding guard)",
      ),
    ).toBe(false);
  });
});

describe("passRates with provider failures", () => {
  it("reports them apart instead of counting them as engine failures", async () => {
    const { passRates } = await import("../src/lib.js");
    const t = {
      durationMs: 1,
      llmCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
    };
    const ok = {
      scenario: "a/new-data",
      pass: true,
      match: true,
      agent: null,
      hotpath: t,
      fallback: false,
    };
    const lost = { ...ok, pass: false, providerError: true };
    const engine = { ...ok, pass: false };
    expect(passRates([[ok], [lost], [engine]] as never)).toEqual([
      { scenario: "a/new-data", passes: 1, runs: 2, excluded: 1 },
    ]);
  });
});

describe("agentProviderFailure", () => {
  it("spots the fallback agent's provider error after a drift", async () => {
    const { agentProviderFailure } = await import("../src/rejections-lib.js");
    const out =
      "⚠ drift at s1: result/lines/0 must have required property 'amount'\n" +
      "demo-agent: 503 status code (no body)\nagent command failed (exit 1)";
    expect(agentProviderFailure(out)).toBe(true);
    expect(
      agentProviderFailure("⚠ drift at s1: x\nagent command failed (exit 1)"),
    ).toBe(false);
  });
});
