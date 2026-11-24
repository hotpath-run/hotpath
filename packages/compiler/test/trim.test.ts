// A.8: lists code fully accounts for are left out of the replay prompt. Measured on
// the hard bench: the big logs day sent 1,200 lines and cost about what the agent did.
import { describe, expect, it } from "vitest";

import {
  renderTemplate,
  trimData,
  type TemplateContext,
} from "@hotpathrun/shared";

import { learnCalculations } from "../src/calculations.js";
import { learnTrim } from "../src/trim.js";

const line = (level: string, svc: string, msg: string, i: number) =>
  `2026-11-01T${String(i % 24).padStart(2, "0")}:00:00Z ${level} ${svc}: ${msg}`;
const lines = (svc: string, errors: Record<string, number>, info: number) => [
  ...Array.from({ length: info }, (_, i) => line("INFO", svc, "request ok", i)),
  ...Object.entries(errors).flatMap(([msg, n]) =>
    Array.from({ length: n }, (_, i) => line("ERROR", svc, msg, i)),
  ),
];
const ctx: TemplateContext = {
  inputs: { date: "2026-11-01" },
  steps: {
    s1: {
      result: {
        service: "payments",
        lines: lines("payments", { "db connection reset": 5, timeout: 2 }, 40),
      },
    },
    s2: {
      result: {
        service: "search",
        lines: lines("search", { "rate limit exceeded": 8, timeout: 4 }, 30),
      },
    },
    s3: {
      result: {
        service: "auth",
        lines: lines("auth", { "invalid token signature": 3 }, 25),
      },
    },
  },
};
const prompt =
  "s1 get_logs result:\n{{steps.s1.result}}\n\ns2 get_logs result:\n{{steps.s2.result}}\n\n" +
  "s3 get_logs result:\n{{steps.s3.result}}\n\nwrite the `text` for `send_message`.";
const report =
  '2026-11-01 error summary: payments — 7 ERROR lines; most frequent: "db connection reset" (5). ' +
  'search — 12 ERROR lines; most frequent: "rate limit exceeded" (8). ' +
  'auth — 3 ERROR lines; most frequent: "invalid token signature" (3).';

const learn = (example: string, c = ctx) =>
  learnTrim({ prompt, example, ctx: c, calcs: learnCalculations(example, c) });

describe("leaving out lists code accounts for", () => {
  it("leaves out the log lines when code computes every count and message the report gives", () => {
    const trim = learn(report);
    expect(trim).toEqual([
      "steps.s1.result.lines",
      "steps.s2.result.lines",
      "steps.s3.result.lines",
    ]);
    const sent = String(renderTemplate(prompt, trimData(ctx, trim)!));
    expect(sent).not.toContain("request ok");
    expect(sent).toContain('"service":"payments"');
    expect(sent).toContain("47 items not shown");
    expect(sent.length).toBeLessThan(
      String(renderTemplate(prompt, ctx)).length / 5,
    );
  });

  it("keeps them when the report says something code does not compute from them", () => {
    // the first error's time: only in the lines
    expect(learn(`${report} First error at request ok.`)).toEqual([]);
    // a figure no formula explains
    expect(learn(`${report} 17 lines were slow.`)).toEqual([]);
  });

  it("keeps them when code computes only some of the report's figures", () => {
    const countsOnly =
      "payments — 7 ERROR lines, worst: db connection reset. search — 12 ERROR lines. auth — 3 ERROR lines.";
    // "db connection reset" is in the lines and in no computed figure
    expect(learn(countsOnly)).toEqual([]);
  });

  it("keeps short lists: they cost little to send", () => {
    const small: TemplateContext = {
      inputs: {},
      steps: {
        s1: {
          result: {
            service: "payments",
            lines: lines("payments", { x: 3 }, 2),
          },
        },
        s2: {
          result: { service: "search", lines: lines("search", { x: 5 }, 2) },
        },
        s3: {
          result: { service: "auth", lines: lines("auth", { x: 2 }, 2) },
        },
      },
    };
    expect(
      learn(
        "payments: 3 ERROR lines. search: 5 ERROR lines. auth: 2 ERROR lines.",
        small,
      ),
    ).toEqual([]);
  });

  it("HOTPATH_TRIM=0 sends everything, as before", () => {
    process.env.HOTPATH_TRIM = "0";
    try {
      expect(learn(report)).toEqual([]);
    } finally {
      delete process.env.HOTPATH_TRIM;
    }
  });
});
