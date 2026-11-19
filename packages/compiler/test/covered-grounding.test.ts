import { describe, expect, it } from "vitest";

import { collectGrounding } from "../src/compiler.js";

// weekly-report, recorded 2026-11-16: the title "Nightly job performance"
// contains the label "performance", which the text never wrote for itself
const results = [
  {
    id: "s10",
    result: {
      issues: [
        {
          number: 77,
          title: "Nightly job performance",
          labels: ["performance"],
        },
        { number: 81, title: "Base image digest pinning", labels: ["chore"] },
      ],
    },
  },
];
const example =
  "Open issues: Nightly job performance (77), Base image digest pinning (81).";

describe("grounding: a value seen only inside a longer one", () => {
  it("is not required (the label inside the title)", () => {
    const g = collectGrounding(example, results);
    expect(g.some((e) => e.value === "performance")).toBe(false);
    expect(g.some((e) => e.value === "Nightly job performance")).toBe(true);
  });

  it("is required when the text also writes it on its own", () => {
    // one issue named: the list is not required item by item, so the label is not covered
    const text = "Open issue: Nightly job performance. Labels: performance.";
    const g = collectGrounding(text, results);
    expect(g.some((e) => e.value === "performance")).toBe(true);
  });
});

// the weekly-report recording (2026-11-16): open issues read once per repo,
// web-app with a single issue; the agent wrote "Nightly job performance" for
// issue 77 (title "Nightly job exceeds 30 minutes", label "performance")
const perRepo = [
  {
    id: "s6",
    result: {
      repo: "payments-api",
      issues: [
        {
          number: 412,
          title: "Refund webhook is retried twice",
          labels: ["bug"],
        },
        {
          number: 418,
          title: "Support SEPA direct debit",
          labels: ["feature"],
        },
      ],
    },
  },
  {
    id: "s8",
    result: {
      repo: "web-app",
      issues: [
        { number: 203, title: "Checkout button misaligned", labels: ["bug"] },
      ],
    },
  },
  {
    id: "s10",
    result: {
      repo: "infra-tools",
      issues: [
        {
          number: 77,
          title: "Nightly job exceeds 30 minutes",
          labels: ["performance"],
        },
        {
          number: 81,
          title: "Pin the base image digest",
          labels: ["security"],
        },
      ],
    },
  },
];
const weekly =
  "- payments-api: Refund webhook bug (412), SEPA support (418).\n" +
  "- web-app: Checkout button alignment (203).\n" +
  "- infra-tools: Nightly job performance (77), Base image digest pinning (81).";

describe("grounding: the same list read in several steps", () => {
  it("requires every item of a one-item list when the text covered all of them across steps", () => {
    const g = collectGrounding(weekly, perRepo);
    const paths = g.flatMap((e) => e.paths);
    expect(paths).toContain("steps.s8.result.issues.*.number");
    expect(
      g.find((e) => e.paths.includes("steps.s8.result.issues.*.number"))
        ?.positions,
    ).toBeUndefined();
  });

  it("drops a tag inside one item when the list's items are all required", () => {
    const g = collectGrounding(weekly, perRepo);
    expect(g.some((e) => e.value === "performance")).toBe(false);
    expect(g.flatMap((e) => e.paths)).toContain(
      "steps.s10.result.issues.*.number",
    );
  });

  it("keeps a one-item list positional when nothing else shares its shape", () => {
    const g = collectGrounding("web-app: Checkout button alignment (203).", [
      perRepo[1]!,
    ]);
    expect(g.find((e) => e.value === 203)?.positions).toEqual([0]);
  });
});
