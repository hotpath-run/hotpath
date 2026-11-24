import { describe, expect, it } from "vitest";

import type { Calculation, TemplateContext } from "@hotpathrun/shared";

import {
  figureProblems,
  foreignAddresses,
  inputGrowth,
  todaysFigures,
} from "../src/checks.js";

const ctx: TemplateContext = {
  inputs: {},
  steps: {
    s1: { result: { orders: [{ id: "A" }, { id: "B" }, { id: "C" }] } },
  },
};
const count: Calculation = {
  line: "<calculated> orders in total.",
  op: "count",
  list: "steps.s1.result.orders",
  recorded: 2,
};

describe("figureProblems", () => {
  it("asks for today's count", () => {
    const f = todaysFigures([count], ctx);
    expect(f.map((x) => x.text)).toEqual(["3 orders in total."]);
    expect(figureProblems(f, ctx, "Orders: A, B.").missing).toEqual(["3"]);
    expect(figureProblems(f, ctx, "3 orders in total.").missing).toEqual([]);
  });

  it("does not call a small recorded number copied: a 2 turns up for other reasons", () => {
    const f = todaysFigures([count], ctx);
    const text = "3 orders in total, 2 of them paid.";
    expect(figureProblems(f, ctx, text)).toEqual({ missing: [], stale: [] });
  });

  it("calls a distinctive recorded figure copied", () => {
    const sum: Calculation = { ...count, recorded: -297.5 };
    const f = todaysFigures([sum], ctx);
    expect(figureProblems(f, ctx, "3 orders, total -297.5 EUR").stale).toEqual([
      "-297.5",
    ]);
  });
});

describe("figureProblems: clock times", () => {
  const day: TemplateContext = {
    inputs: {},
    steps: {
      s1: {
        result: {
          utc_offset: "+02:00",
          meetings: [
            { title: "Launch check", start_utc: "2026-10-02T08:15:00Z" },
            { title: "Budget sign-off", start_utc: "2026-10-02T14:45:00Z" },
          ],
        },
      },
    },
  };
  const time: Calculation = {
    line: "- 09:30: Roadmap review",
    op: "time",
    list: "steps.s1.result.meetings",
    field: "start_utc",
    key: "title",
    shift: { offsetRef: "steps.s1.result.utc_offset" },
    recorded: 2,
  };

  it("hands the model local times and accepts a text that states them", () => {
    const f = todaysFigures([time], day);
    expect(f.map((x) => x.text)).toEqual([
      "Launch check: 10:15",
      "Budget sign-off: 16:45",
    ]);
    const ok = "- 10:15 Launch check\n- 4:45 PM Budget sign-off";
    expect(figureProblems(f, day, ok)).toEqual({ missing: [], stale: [] });
  });

  it("rejects a UTC time written as local, or a wrong conversion", () => {
    const f = todaysFigures([time], day);
    const utc = "- 08:15 Launch check\n- 14:45 Budget sign-off";
    expect(figureProblems(f, day, utc).missing).toEqual(["10:15", "16:45"]);
    const off = "- 10:15 Launch check\n- 17:45 Budget sign-off";
    expect(figureProblems(f, day, off).missing).toEqual(["16:45"]);
  });
});

describe("foreignAddresses (security finding 5)", () => {
  const data: TemplateContext = {
    inputs: {},
    steps: {
      s1: {
        result: {
          emails: [
            { from: "carol@corp.com", link: "https://docs.corp.com/v2" },
          ],
        },
      },
    },
  };
  const example = "Brief. Dashboard: https://status.corp.com.";

  it("allows links and addresses from the data and the recorded example", () => {
    expect(
      foreignAddresses(
        "Carol (carol@corp.com) shared https://docs.corp.com/v2. See https://status.corp.com.",
        data,
        example,
      ),
    ).toEqual([]);
  });

  it("ends a link at full-width punctuation (a free model's Chinese bracket after it)", () => {
    expect(
      foreignAddresses(
        "见 https://docs.corp.com/v2）— 和 https://evil.example/x。",
        data,
        example,
      ),
    ).toEqual(["https://evil.example/x"]);
  });

  it("flags a link or address nobody gave", () => {
    expect(
      foreignAddresses(
        "Total -428. Details: https://evil.example/c?q=-428 or mail ops@evil.example.",
        data,
        example,
      ),
    ).toEqual(["https://evil.example/c?q=-428", "ops@evil.example"]);
  });
});

describe("the cost guard's warning (A.8)", () => {
  it("warns only when today's data is far bigger than the recording's", () => {
    expect(inputGrowth("s4", 4500, 1500)).toBeNull(); // 3× but only 3,000 more
    expect(inputGrowth("s4", 20000, 10000)).toBeNull(); // 2×
    expect(inputGrowth("s4", 30000, undefined)).toBeNull(); // compiled before A.8
    expect(inputGrowth("s4", 52300, 16800)).toMatch(
      /^⚠ s4: today's data for the model is 52,300 characters, 3\.1× the recording's 16,800/,
    );
  });
});

describe("a top figure must name its item", () => {
  it("is missing when the text states the number but not the name", () => {
    const top = [
      {
        text: "NA top customer: Stark (5100)",
        value: 5100,
        name: "Stark",
        calc: count,
      },
    ];
    expect(figureProblems(top, ctx, "NA: Wayne with 5100").missing).toEqual([
      "Stark",
    ]);
    expect(figureProblems(top, ctx, "NA: stark with 5,100").missing).toEqual(
      [],
    );
    // "none (0)": any wording of nothing will do
    const none = [
      { text: "auth: none (0)", value: 0, name: "none", calc: count },
    ];
    expect(figureProblems(none, ctx, "auth had 0 errors").missing).toEqual([]);
  });
});
