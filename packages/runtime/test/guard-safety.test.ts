// Is the grounding guard still safe? Deliberately wrong reports for a new day
// (morning-brief, checked-in recording) must be rejected, and correct reports
// the old per-position guard rejected must be accepted. Both guards are built
// from the same recording: HOTPATH_RELAX_GROUNDING=0 is the old one.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { compileTrace } from "@hotpathrun/compiler";
import { readTrace, type TemplateContext } from "@hotpathrun/shared";

import { checkGrounding, checkLlmGuard, checkStale } from "../src/runtime.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const trace = await readTrace(
  path.join(repoRoot, "packages/compiler/test/fixtures/morning-brief.jsonl"),
);

// 2026-10-02: other emails, other events, other weather
const ctx: TemplateContext = {
  inputs: { date: "2026-10-02" },
  steps: {
    s1: {
      result: {
        emails: [
          {
            id: "e4",
            from: "carol@corp.com",
            subject: "Launch checklist for v2 is ready",
          },
          {
            id: "e5",
            from: "billing@vendor.io",
            subject: "Invoice #2041 attached",
          },
          {
            id: "e6",
            from: "dave@club.org",
            subject: "Book club: October pick",
          },
        ],
      },
    },
    s2: {
      result: {
        events: [
          { time: "10:00", title: "Sprint planning", location: "Room A" },
          { time: "19:30", title: "Dinner with Ana", location: "Le Comptoir" },
        ],
      },
    },
    s3: {
      result: {
        city: "Paris",
        date: "2026-10-02",
        summary: "Overcast with morning drizzle",
        highC: 17,
        lowC: 9,
      },
    },
  },
};

function guardFor(relax: boolean) {
  if (relax) delete process.env.HOTPATH_RELAX_GROUNDING;
  else process.env.HOTPATH_RELAX_GROUNDING = "0";
  const llm = compileTrace(trace, "x").steps.find((s) => s.type === "llm");
  delete process.env.HOTPATH_RELAX_GROUNDING;
  if (llm?.type !== "llm") throw new Error("no llm step");
  return llm.guard;
}
const oldGuard = guardFor(false);
const newGuard = guardFor(true);
afterEach(() => delete process.env.HOTPATH_RELAX_GROUNDING);

/** null = accepted; otherwise why the guard rejects it */
function verdict(guard: typeof newGuard, text: string): string | null {
  const length = checkLlmGuard(guard, text, 8);
  if (length) return length;
  const missing = checkGrounding(guard.grounding, ctx, text);
  if (missing.length > 0) return `missing: ${missing.join("; ")}`;
  const stale = checkStale(guard.exampleFacts, ctx, text);
  return stale.length > 0 ? `stale: ${stale.join("; ")}` : null;
}

const GOOD = [
  "Morning brief - Fri 2026-10-02",
  "",
  "WEATHER (Paris): Overcast with morning drizzle. High 17°C, low 9°C.",
  "",
  "CALENDAR:",
  "- 10:00 Sprint planning (Room A)",
  "- 19:30 Dinner with Ana (Le Comptoir)",
  "",
  "EMAILS:",
  '- "Launch checklist for v2 is ready" (carol@corp.com): two items still need an owner.',
  '- "Invoice #2041 attached" (billing@vendor.io): total due EUR 340.00.',
  '- "Book club: October pick" (dave@club.org): discussion on the 20th.',
].join("\n");

describe("correct reports are accepted (they were rejected before)", () => {
  it("a report in the recording's own style, for a new day, passes", () => {
    expect(verdict(newGuard, GOOD)).toBeNull();
  });
  it("a different layout with every item still passes", () => {
    const text = [
      "2026-10-02, Paris: Overcast with morning drizzle, 17°C high, 9°C low.",
      "Today: Sprint planning at 10:00 in Room A; Dinner with Ana at 19:30, Le Comptoir.",
      "Mail: Launch checklist for v2 is ready (carol@corp.com); Invoice #2041 attached (billing@vendor.io); Book club: October pick (dave@club.org).",
    ].join("\n");
    expect(verdict(newGuard, text)).toBeNull();
  });
});

describe("wrong reports are rejected, by the new guard as by the old", () => {
  const wrong: Array<[string, string]> = [
    ["leaves an email out", GOOD.replace(/.*Invoice #2041.*\n/, "")],
    [
      "leaves the date out",
      GOOD.replace("Morning brief - Fri 2026-10-02", "Morning brief"),
    ],
    ["leaves the weather out", GOOD.replace(/.*WEATHER.*\n/, "")],
    ["leaves a calendar event out", GOOD.replace(/.*Dinner with Ana.*\n/, "")],
    [
      "gives yesterday's temperature",
      GOOD.replace("High 17°C, low 9°C", "High 21°C, low 11°C"),
    ],
    [
      "copies yesterday's event",
      GOOD + "\n- 09:30 Standup with Platform team (Room B)",
    ],
    [
      "copies yesterday's email",
      GOOD + '\n- "Q3 budget review moved to 14:00" (Alice)',
    ],
    ["says nothing useful", "Nothing to report today."],
    ["is empty", ""],
    ["leaves every email out", GOOD.replace(/EMAILS:[\s\S]*$/, "")],
  ];
  for (const [name, text] of wrong) {
    it(`a report that ${name}`, () => {
      expect(verdict(newGuard, text), "new guard").not.toBeNull();
      expect(verdict(oldGuard, text), "old guard").not.toBeNull();
    });
  }
});

describe("the base report is accepted by both guards, so the rejections above are about the mutation", () => {
  it("accepted by the old and the new guard", () => {
    expect(verdict(oldGuard, GOOD)).toBeNull();
    expect(verdict(newGuard, GOOD)).toBeNull();
  });
});
