// Requirements tied to one position of a list are an accident of the recording.
// They become "every item is covered" (already required) or "at least as many
// items as the recording cited". Values outside lists are untouched.
import { describe, expect, it } from "vitest";

import { relaxPositional } from "../src/grounding.js";

describe("relaxPositional", () => {
  it("drops a positional entry when every item of that list is already required", () => {
    const out = relaxPositional([
      { value: "Alice", paths: ["steps.s1.result.emails.*.subject"] },
      { value: "news@city.io", paths: ["steps.s1.result.emails.2.from"] },
    ]);
    expect(out).toEqual([
      { value: "Alice", paths: ["steps.s1.result.emails.*.subject"] },
    ]);
  });

  it("turns positional entries of an uncovered list into the recorded positions", () => {
    const out = relaxPositional([
      { value: "AWS invoice", paths: ["steps.s1.result.lines.3.description"] },
      { value: 450, paths: ["steps.s1.result.lines.5.amount"] },
      { value: "Bank fee", paths: ["steps.s1.result.lines.6.description"] },
    ]);
    expect(out).toEqual([
      {
        value: "AWS invoice",
        paths: [
          "steps.s1.result.lines.*.description",
          "steps.s1.result.lines.*.amount",
        ],
        positions: [3, 5, 6],
      },
    ]);
  });

  it("two entries about the same item count as one item", () => {
    const out = relaxPositional([
      { value: "Budget", paths: ["steps.s2.result.events.1.title"] },
      { value: "14:00", paths: ["steps.s2.result.events.1.start"] },
    ]);
    expect(out[0]).toMatchObject({ positions: [1] });
  });

  it("leaves values that are not inside a list alone", () => {
    const entries = [
      { value: 21, paths: ["steps.s3.result.highC"] },
      { value: "Paris", paths: ["steps.s3.result.city"] },
    ];
    expect(relaxPositional(entries)).toEqual(entries);
  });

  it("keeps the non-positional paths of an entry that also had a positional one", () => {
    const out = relaxPositional([
      {
        value: "14:00",
        paths: ["steps.s2.result.start", "steps.s1.result.emails.0.subject"],
      },
    ]);
    expect(out).toContainEqual({
      value: "14:00",
      paths: ["steps.s2.result.start"],
    });
  });
});
