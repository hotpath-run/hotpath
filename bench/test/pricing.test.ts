import { describe, expect, it } from "vitest";

import {
  priceTokenLog,
  type PricePair,
  type TokenLine,
} from "../src/pricing.js";

const opusToHaiku: PricePair = {
  label: "Claude: Opus agent → Haiku replay",
  agent: { model: "opus", inPer1M: 4, outPer1M: 20 },
  replay: { model: "haiku", inPer1M: 0.1, outPer1M: 0.5 },
};

const line = (
  agent: [number, number] | null,
  hotpath: [number, number],
  pass = true,
): TokenLine => ({
  scenario: "morning-brief/new-data",
  pass,
  fallback: false,
  agent: agent && {
    llmCalls: 3,
    promptTokens: agent[0],
    completionTokens: agent[1],
  },
  hotpath: {
    llmCalls: 1,
    promptTokens: hotpath[0],
    completionTokens: hotpath[1],
  },
});

describe("priceTokenLog", () => {
  it("prices each run's tokens at the pair's rates and averages them", () => {
    // agent: 3000 in × $4 + 500 out × $20 = $0.012 + $0.010 = $0.022
    // replay: 400 in × $0.10 + 100 out × $0.50 = $0.00004 + $0.00005 = $0.00009
    const [row] = priceTokenLog([line([3000, 500], [400, 100])], [opusToHaiku]);
    expect(row.agentUsdPerRun).toBeCloseTo(0.022, 6);
    expect(row.replayUsdPerRun).toBeCloseTo(0.00009, 8);
    expect(row.cheaper).toBeCloseTo(0.022 / 0.00009, 3);
    expect(row.runs).toBe(1);
  });

  it("projects a month at a given number of runs per day", () => {
    const [row] = priceTokenLog(
      [line([3000, 500], [400, 100])],
      [opusToHaiku],
      1000,
    );
    expect(row.agentUsdPerMonth).toBeCloseTo(0.022 * 1000 * 30, 6);
    expect(row.replayUsdPerMonth).toBeCloseTo(0.00009 * 1000 * 30, 6);
  });

  it("only uses runs that passed and have an agent comparison", () => {
    const [row] = priceTokenLog(
      [
        line([3000, 500], [400, 100]),
        line(null, [400, 100]), // no comparison agent run
        line([9999, 9999], [9999, 9999], false), // failed: not a fair price
      ],
      [opusToHaiku],
    );
    expect(row.runs).toBe(1);
    expect(row.agentUsdPerRun).toBeCloseTo(0.022, 6);
  });

  it("returns no row for a pair when no run qualifies", () => {
    expect(priceTokenLog([line(null, [1, 1])], [opusToHaiku])).toEqual([]);
  });
});
