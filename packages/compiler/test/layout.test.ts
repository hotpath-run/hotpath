// task 05: lines that are one row per item of a list are found at
// compile time and written by code at run time, so the replay model writes only
// the rest. The compiler takes a group of lines only when it is certain.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  fillRows,
  readTrace,
  renderRow,
  workflowSchema,
  type TemplateContext,
} from "@hotpathrun/shared";

import { compileTrace, inferLayout } from "../src/index.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/morning-brief.jsonl",
);

const EMAILS = [
  { id: "e1", from: "alice@corp.com", subject: "Q3 budget review moved" },
  { id: "e2", from: "bob@corp.com", subject: "Team offsite agenda" },
  { id: "e3", from: "news@city.io", subject: "Metro line 4 closed" },
];
const sources = (emails: unknown, extra: Record<string, unknown> = {}) => [
  { id: "s1", result: { emails } },
  { id: "s2", result: { summary: "Sunny", highC: 21, ...extra } },
];
const ctx = (emails: unknown): TemplateContext => ({
  inputs: {},
  steps: { s1: { result: { emails } }, s2: { result: { summary: "Rain" } } },
});

describe("inferLayout", () => {
  const text = [
    "Good morning!",
    "Emails:",
    "- Q3 budget review moved (alice@corp.com)",
    "- Team offsite agenda (bob@corp.com)",
    "- Metro line 4 closed (news@city.io)",
    "Weather: Sunny, 21°C.",
  ].join("\n");

  it("turns one line per item into a row template and leaves the rest", () => {
    const layout = inferLayout(text, sources(EMAILS))!;
    expect(layout.rows).toEqual([
      {
        marker: "[[rows:1]]",
        over: "steps.s1.result.emails",
        template: "- {{item.subject}} ({{item.from}})",
      },
    ]);
    expect(layout.skeleton).toBe(
      ["Good morning!", "Emails:", "[[rows:1]]", "Weather: Sunny, 21°C."].join(
        "\n",
      ),
    );
  });

  it("round trip: filling the skeleton with the recorded data gives the recorded text", () => {
    const layout = inferLayout(text, sources(EMAILS))!;
    expect(fillRows(layout.skeleton, layout.rows, ctx(EMAILS))).toBe(text);
  });

  it("on other data: one row per item, however many there are", () => {
    const layout = inferLayout(text, sources(EMAILS))!;
    const today = [
      { from: "zoe@x.org", subject: "Invoice #2041" },
      { from: "li@y.org", subject: "Launch checklist" },
      { from: "sam@z.org", subject: "Book club" },
      { from: "kim@w.org", subject: "Lunch?" },
    ];
    expect(fillRows(layout.skeleton, layout.rows, ctx(today))).toBe(
      [
        "Good morning!",
        "Emails:",
        "- Invoice #2041 (zoe@x.org)",
        "- Launch checklist (li@y.org)",
        "- Book club (sam@z.org)",
        "- Lunch? (kim@w.org)",
        "Weather: Sunny, 21°C.",
      ].join("\n"),
    );
    // an empty list leaves no row
    expect(fillRows(layout.skeleton, layout.rows, ctx([]))).toBe(
      ["Good morning!", "Emails:", "Weather: Sunny, 21°C."].join("\n"),
    );
  });

  const none = (lines: string[], emails: unknown = EMAILS, extra = {}) =>
    expect(
      inferLayout(lines.join("\n"), sources(emails, extra)),
    ).toBeUndefined();

  it("needs a line for every item, in order", () => {
    none([
      "- Q3 budget review moved (alice@corp.com)",
      "- Team offsite agenda (bob@corp.com)",
    ]);
    none([
      "- Team offsite agenda (bob@corp.com)",
      "- Q3 budget review moved (alice@corp.com)",
      "- Metro line 4 closed (news@city.io)",
    ]);
  });

  it("needs the same template on every line", () => {
    none([
      "- Q3 budget review moved (alice@corp.com)",
      "- Team offsite agenda, from bob@corp.com",
      "- Metro line 4 closed (news@city.io)",
    ]);
  });

  it("refuses rows whose label text holds a digit (numbering, a reformatted amount)", () => {
    none([
      "1. Q3 budget review moved",
      "2. Team offsite agenda",
      "3. Metro line 4 closed",
    ]);
    const orders = [
      { id: "A-1", customer: "Lutèce", total: 89 },
      { id: "A-2", customer: "Vernet", total: 89 },
    ];
    // 89 written as $89.00 is not the value: it would be copied to every row
    none(["- Lutèce: $89.00", "- Vernet: $89.00"], orders);
  });

  it("refuses rows whose label text holds a value in another form", () => {
    const orders = [
      { customer: "Lutèce", status: "paid" },
      { customer: "Vernet", status: "paid" },
    ];
    none(["- Lutèce (Paid)", "- Vernet (Paid)"], orders);
    // …or a value from another result, the same on every row that day
    none(
      ["- Q3 budget review moved (Sunny)", "- Team offsite agenda (Sunny)"],
      EMAILS.slice(0, 2),
    );
  });

  it("a single item is not a pattern", () => {
    none(["- Q3 budget review moved (alice@corp.com)"], EMAILS.slice(0, 1));
  });
});

describe("fillRows", () => {
  const rows = [
    {
      marker: "[[rows:1]]",
      over: "steps.s1.result.emails",
      template: "- {{item.subject}}",
    },
  ];
  it("gives null when the text cannot be filled, so the caller keeps it as it is", () => {
    const c = ctx(EMAILS);
    expect(fillRows("no marker here", rows, c)).toBeNull();
    expect(fillRows("[[rows:1]]\n[[rows:1]]", rows, c)).toBeNull();
    expect(fillRows("Emails: [[rows:1]] and more", rows, c)).toBeNull();
    expect(fillRows("[[rows:1]]\n[[rows:2]]", rows, c)).toBeNull();
    // the list is gone, or an item lacks the field
    expect(fillRows("[[rows:1]]", rows, ctx("none"))).toBeNull();
    expect(fillRows("[[rows:1]]", rows, ctx([{ title: "x" }]))).toBeNull();
    expect(renderRow("- {{item.subject}}", { subject: null })).toBeNull();
    expect(renderRow("{{item.a.b}}: {{item.n}}", { a: { b: "x" }, n: 3 })).toBe(
      "x: 3",
    );
  });
});

describe("compiled workflow (fixture trace)", () => {
  it("the AI step carries the layout, and it round-trips on the recorded data", async () => {
    const trace = await readTrace(fixture);
    const workflow = workflowSchema.parse(compileTrace(trace, "x"));
    const llm = workflow.steps.find((s) => s.type === "llm");
    if (llm?.type !== "llm" || !llm.layout) throw new Error("no layout");
    expect(llm.layout.rows).toEqual([
      {
        marker: "[[rows:1]]",
        over: "steps.s1.result.emails",
        template: "- {{item.subject}} ({{item.from}})",
      },
      {
        marker: "[[rows:2]]",
        over: "steps.s2.result.events",
        template: "- {{item.time}} {{item.title}}, {{item.location}}",
      },
    ]);
    const recorded: TemplateContext = {
      inputs: trace.meta.inputs,
      steps: {
        s1: { result: trace.calls[0]!.result },
        s2: { result: trace.calls[1]!.result },
      },
    };
    expect(fillRows(llm.layout.skeleton, llm.layout.rows, recorded)).toBe(
      llm.example,
    );
    // what the model is left to write: 5 of the 11 lines, none of them a row
    expect(llm.layout.skeleton.split("\n")).toHaveLength(
      llm.example.split("\n").length - 3,
    );
  });
});
