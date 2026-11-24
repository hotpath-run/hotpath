// A.5: per-item choices that follow one number in bands (a lead's tier from its
// company's employee count) are decided by code, so the summary after them is
// written from decisions that cannot disagree.
import { describe, expect, it } from "vitest";

import { bandDecision, inOpenGap, type ItemDecision } from "@hotpathrun/shared";

import { learnBands, writtenThresholds } from "../src/decision-bands.js";

const lead = (id: string, employees: number, tier: string) => ({
  item: { id, company_domain: `${id}.com` },
  details: { name: `${id} Inc`, employees, country: "FR" },
  choice: { action: "update_lead", tier },
});
const decide = (examples: ItemDecision["examples"]): ItemDecision => ({
  model: "cheap",
  prompt: "",
  key: ["id"],
  details: { step: "s2" },
  actions: [{ tool: "update_lead", fields: { tier: "string" } }],
  examples,
});
const RECORDED = decide([
  lead("a", 12, "smb"),
  lead("b", 5000, "enterprise"),
  lead("c", 100, "mid"),
  lead("d", 999, "mid"),
  lead("e", 40, "smb"),
  lead("f", 1200, "enterprise"),
]);
// the agent's summary: "enterprise ≥1000, mid 100–999, smb <100"
const WRITTEN = [1000, 100, 999, 6, 2, 2, 2];

describe("bands for per-item choices", () => {
  it("learns the tier bands, closed by the thresholds the agent wrote", () => {
    const bands = learnBands(RECORDED, WRITTEN)!;
    expect(bands).toEqual({
      from: "details",
      path: ["employees"],
      action: "update_lead",
      field: "tier",
      bands: [
        { value: "smb", lt: 100 },
        { value: "mid", gte: 100, lt: 1000 },
        { value: "enterprise", gte: 1000 },
      ],
    });
    const tier = (employees: number) =>
      bandDecision(bands, {}, { employees })?.tier;
    expect([1, 99, 100, 500, 999, 1000, 250000].map(tier)).toEqual([
      "smb",
      "smb",
      "mid",
      "mid",
      "mid",
      "enterprise",
      "enterprise",
    ]);
  });

  it("leaves a gap nobody wrote about open", () => {
    const many = decide([
      lead("a", 10, "smb"),
      lead("b", 20, "smb"),
      lead("c", 30, "smb"),
      lead("d", 300, "mid"),
      lead("e", 400, "mid"),
      lead("f", 500, "mid"),
    ]);
    const bands = learnBands(many, [])!;
    expect(bands.bands).toEqual([
      { value: "smb", lte: 30 },
      { value: "mid", gte: 300 },
    ]);
    expect(bandDecision(bands, {}, { employees: 150 })).toBeNull();
    // between two bands: nobody knows its side (the runtime hands it to the agent)
    expect(inOpenGap(bands, {}, { employees: 150 })).toBe(150);
    // below the lowest band or with no number: not a gap
    expect(inOpenGap(bands, {}, { employees: 5 })).toBeNull();
    expect(inOpenGap(bands, {}, {})).toBeNull();
    expect(bandDecision(bands, {}, { employees: 25 })).toEqual({
      action: "update_lead",
      tier: "smb",
    });
  });

  it("reads thresholds, not counts, from what the agent wrote", () => {
    expect(
      writtenThresholds(
        "24 leads across 5 pages. Tier summary: enterprise = 9, mid = 9, smb = 6. " +
          "Tiers were assigned by employee count: enterprise ≥1000, mid 100–999, smb <100.",
      ).sort((a, b) => a - b),
    ).toEqual([100, 100, 999, 1000]);
    expect(
      writtenThresholds("1,000 or more is enterprise; below 100 smb"),
    ).toEqual([1000, 100]);
    expect(writtenThresholds("50 leads were tiered, 3 of them mid.")).toEqual(
      [],
    );
  });

  it("closes a gap the recording itself closed (99 smb, 100 mid), and leaves the other open", () => {
    // the hard bench's crm recording: the agent wrote no threshold
    const rec = decide([
      lead("a", 20000, "enterprise"),
      lead("b", 100, "mid"),
      lead("c", 320, "mid"),
      lead("d", 1500, "enterprise"),
      lead("e", 999, "mid"),
      lead("f", 80, "smb"),
      lead("g", 99, "smb"),
    ]);
    expect(learnBands(rec, [])?.bands).toEqual([
      { value: "smb", lt: 100 },
      { value: "mid", gte: 100, lte: 999 },
      { value: "enterprise", gte: 1500 },
    ]);
  });

  it("learns nothing from few items and no written threshold", () => {
    expect(learnBands(RECORDED, [])).toBeNull();
  });

  it("learns nothing when the values overlap", () => {
    const mixed = decide([
      lead("a", 10, "smb"),
      lead("b", 500, "smb"),
      lead("c", 300, "mid"),
      lead("d", 900, "mid"),
    ]);
    expect(learnBands(mixed, [100, 1000])).toBeNull();
  });

  it("learns nothing when the items got different actions", () => {
    const acts = decide([
      ...RECORDED.examples.slice(0, 5),
      { ...lead("z", 7, "smb"), choice: { action: "none" } },
    ]);
    expect(learnBands(acts, WRITTEN)).toBeNull();
  });
});
