import { describe, expect, it } from "vitest";

import { inferInputs } from "../src/index.js";

import { bankRun, parseTrace, fixtureText, unlabelledRun } from "./helpers.js";

const dates = ["2026-10-01", "2026-10-02", "2026-10-05"];

describe("inferInputs", () => {
  for (const task of ["morning-brief", "bank-reconciliation"]) {
    it(`finds the hand-written inputs of ${task} from 3 unlabelled runs`, () => {
      const handWritten = parseTrace(fixtureText(task)).meta.inputs;
      const runs = dates.map((d) => unlabelledRun(task, d));
      const inferred = inferInputs(runs);
      expect(Object.keys(inferred.inputs).sort()).toEqual(
        Object.keys(handWritten).sort(),
      );
      expect(inferred.perRun.map((r) => r.date)).toEqual(dates);
      expect(inferred.inputs.date).toEqual({
        type: "string",
        example: "2026-10-05",
      });
    });
  }

  it("keeps what never changes as a constant", () => {
    const inferred = inferInputs(
      dates.map((d) => unlabelledRun("morning-brief", d)),
    );
    // city "Paris" and to "me" are the same every run
    expect(inferred.inputs).not.toHaveProperty("city");
    expect(inferred.inputs).not.toHaveProperty("to");
  });

  it("does not take page numbers or values read from a result as inputs", () => {
    const inferred = inferInputs([
      bankRun("2026-10-01", 2),
      bankRun("2026-10-02", 3),
      bankRun("2026-10-03", 1),
    ]);
    expect(Object.keys(inferred.inputs)).toEqual(["date"]);
  });

  it("names two inputs with the same argument name apart", () => {
    const runs = dates.map((d, i) => {
      const run = unlabelledRun("morning-brief", d);
      return {
        ...run,
        calls: run.calls.map((c) =>
          c.tool === "get_weather"
            ? { ...c, args: { ...c.args, date: `2026-12-0${i + 1}` } }
            : c,
        ),
      };
    });
    const names = Object.keys(inferInputs(runs).inputs).sort();
    expect(names).toEqual(["date", "date_2"]);
  });
});
