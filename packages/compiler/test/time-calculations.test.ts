import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  computeFigures,
  localTime,
  maskDatesAndTimes,
  numbersInText,
  statesTime,
  type TemplateContext,
} from "@hotpathrun/shared";

import { learnCalculations } from "../src/calculations.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../examples/demo-tools/fixtures",
);

async function meetings(set: string): Promise<TemplateContext> {
  const f = JSON.parse(
    await readFile(path.join(fixtures, set, "office.json"), "utf8"),
  );
  return { inputs: { date: f.date }, steps: { s1: { result: f.meetings } } };
}

// the Sonnet recording's text (traces/meeting-times, 2026-11-16)
const EXAMPLE =
  "Here is your schedule for today (2026-10-01):\n- 09:30: Roadmap review\n- 15:00: Vendor sync with Toronto";

describe("clock times computed by code", () => {
  it("learns the local time from the offset the data holds", async () => {
    const calcs = learnCalculations(EXAMPLE, await meetings("default"));
    expect(calcs).toEqual([
      expect.objectContaining({
        op: "time",
        list: "steps.s1.result.meetings",
        field: "start_utc",
        key: "title",
        shift: { offsetRef: "steps.s1.result.utc_offset" },
      }),
    ]);
  });

  it("computes new-data times (UTC plus offset)", async () => {
    const [calc] = learnCalculations(EXAMPLE, await meetings("default"));
    const figures = computeFigures(calc!, await meetings("new-data"));
    expect(figures?.map((f) => f.text)).toEqual([
      "Launch readiness check: 10:15",
      "Call with the Singapore team: 08:00",
      "Budget sign-off: 16:45",
    ]);
  });

  it("claims nothing when the timestamp field is gone (drift)", async () => {
    const [calc] = learnCalculations(EXAMPLE, await meetings("default"));
    expect(computeFigures(calc!, await meetings("drift"))).toBeNull();
  });

  it("works out a zone's own offset, daylight saving included", () => {
    const ctx: TemplateContext = {
      inputs: {},
      steps: { s1: { result: { tz: "Europe/Paris" } } },
    };
    const shift = { zoneRef: "steps.s1.result.tz" };
    expect(localTime("2026-10-01T07:30:00Z", shift, ctx)).toBe("09:30");
    expect(localTime("2026-12-01T07:30:00Z", shift, ctx)).toBe("08:30");
    expect(localTime("not a time", shift, ctx)).toBeNull();
  });

  it("learns no time when a recorded time fits no shift", async () => {
    const wrong = EXAMPLE.replace("09:30", "08:30");
    const calcs = learnCalculations(wrong, await meetings("default"));
    expect(calcs.filter((c) => c.op === "time")).toEqual([]);
  });
});

describe("statesTime", () => {
  it("accepts the usual ways to write a time", () => {
    expect(statesTime("Roadmap at 09:30", "09:30")).toBe(true);
    expect(statesTime("Roadmap at 9:30", "09:30")).toBe(true);
    expect(statesTime("Roadmap at 9:30 AM", "09:30")).toBe(true);
    expect(statesTime("Sync at 3 PM", "15:00")).toBe(true);
    expect(statesTime("Sync at 3:00 p.m.", "15:00")).toBe(true);
    expect(statesTime("Sync at 15.00", "15:00")).toBe(true);
  });

  it("rejects a different time", () => {
    expect(statesTime("Roadmap at 19:30", "09:30")).toBe(false);
    expect(statesTime("Roadmap at 9:30 PM", "09:30")).toBe(false);
    expect(statesTime("Roadmap at 07:30 UTC", "09:30")).toBe(false);
    expect(statesTime("15 items", "15:00")).toBe(false);
  });
});

describe("dates and times are no figures", () => {
  it("masks written dates and clock times", () => {
    expect(numbersInText("Report for October 1, 2026: 3 risks")).toEqual([3]);
    expect(numbersInText("on 1 Oct 2026 and Oct 2026, at 15:00")).toEqual([]);
    expect(numbersInText("total 1,234.50 at 9:30 am")).toEqual([1234.5]);
    expect(maskDatesAndTimes("at 2026-10-01T13:00:00Z").trim()).toBe("at");
  });

  it("does not learn the day of a written date as a count", () => {
    const ctx: TemplateContext = {
      inputs: { date: "2026-10-01" },
      steps: {
        s3: {
          result: { risks: [{ id: "R-1", title: "Vendor delay" }] },
        },
      },
    };
    const text =
      "Here's the project report for October 1, 2026:\n- R-1 Vendor delay";
    expect(learnCalculations(text, ctx)).toEqual([]);
  });
});
