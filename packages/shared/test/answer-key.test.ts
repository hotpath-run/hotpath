import { describe, expect, it } from "vitest";

import { answerKey } from "../src/answer-key.js";

describe("answerKey", () => {
  it("is the same for the same example and data", () => {
    expect(answerKey("ex", "data")).toBe(answerKey("ex", "data"));
    expect(answerKey("ex", "data")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the data or the example (a recompile) changes", () => {
    const key = answerKey("ex", "data");
    expect(answerKey("ex", "data2")).not.toBe(key);
    expect(answerKey("ex2", "data")).not.toBe(key);
    // the separator keeps "a"+"bc" apart from "ab"+"c"
    expect(answerKey("a", "bc")).not.toBe(answerKey("ab", "c"));
  });
});
