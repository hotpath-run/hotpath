import { describe, expect, it } from "vitest";

import { createProgram } from "../src/program.js";

describe("hotpath learn", () => {
  it("is listed, with --promote, --auto and --hot-after", () => {
    const program = createProgram();
    expect(program.helpInformation()).toContain("learn");
    const learn = program.commands.find((c) => c.name() === "learn")!;
    const help = learn.helpInformation();
    for (const flag of ["--promote", "--auto", "--hot-after"]) {
      expect(help).toContain(flag);
    }
  });
});
