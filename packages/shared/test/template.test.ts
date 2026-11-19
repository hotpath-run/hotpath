import { describe, expect, it } from "vitest";

import { renderTemplate } from "../src/template.js";

const ctx = {
  inputs: { date: "2026-10-01", limit: 3 },
  steps: {
    s1: { result: { emails: [{ id: "e1", from: "a@b.c" }] } },
    s4: { output: "the brief text" },
  },
};

describe("renderTemplate (SPEC §5.2)", () => {
  it("exactly-one-template keeps the original type", () => {
    expect(renderTemplate("{{inputs.limit}}", ctx)).toBe(3);
    expect(renderTemplate("{{inputs.date}}", ctx)).toBe("2026-10-01");
    expect(renderTemplate("{{steps.s1.result}}", ctx)).toEqual({
      emails: [{ id: "e1", from: "a@b.c" }],
    });
    expect(renderTemplate("{{steps.s4.output}}", ctx)).toBe("the brief text");
  });

  it("resolves json paths into results", () => {
    expect(renderTemplate("{{steps.s1.result.emails.0.id}}", ctx)).toBe("e1");
    expect(renderTemplate("{{steps.s1.result.emails.0.from}}", ctx)).toBe(
      "a@b.c",
    );
  });

  it("interpolates inside longer strings (non-strings JSON-stringified)", () => {
    expect(renderTemplate("date={{inputs.date}}", ctx)).toBe("date=2026-10-01");
    expect(renderTemplate("ids: {{steps.s1.result}}", ctx)).toBe(
      'ids: {"emails":[{"id":"e1","from":"a@b.c"}]}',
    );
  });

  it("renders nested args structures", () => {
    expect(
      renderTemplate({ d: "{{inputs.date}}", n: ["{{inputs.limit}}"] }, ctx),
    ).toEqual({ d: "2026-10-01", n: [3] });
  });
});

// docs/SECURITY-REVIEW.md, finding 5: data returned by a tool is text, never a
// template. A tool result that contains {{…}} must not pull other values in.
describe("renderTemplate does not expand templates found in data", () => {
  const ctx = {
    inputs: { secret: ["TOP", "SECRET"].join("-") },
    steps: {
      s1: { result: { subject: "hi {{inputs.secret}} {{steps.s2.output}}" } },
      s2: { output: "private" },
    },
  };

  it("inside a longer string", () => {
    const out = renderTemplate("Emails: {{steps.s1.result}}", ctx) as string;
    expect(out).toContain("{{inputs.secret}}");
    expect(out).not.toContain("TOP-SECRET");
    expect(out).not.toContain("private");
  });

  it("as a whole value", () => {
    expect(renderTemplate("{{steps.s1.result.subject}}", ctx)).toBe(
      "hi {{inputs.secret}} {{steps.s2.output}}",
    );
  });
});
