import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/program.js";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "learn",
  "test",
  "fixtures",
  "scan",
);

async function scan(...args: string[]): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => {
    lines.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const program = createProgram();
  program.exitOverride();
  await program.parseAsync(["node", "hotpath", "scan", ...args]);
  return lines.join("\n");
}

afterEach(() => vi.restoreAllMocks());

describe("hotpath scan", () => {
  it("is listed with its options", () => {
    const help = createProgram()
      .commands.find((c) => c.name() === "scan")!
      .helpInformation();
    for (const flag of ["--json", "--html", "--days", "--price", "--run-cost"])
      expect(help).toContain(flag);
  });

  it("prints a summary for a folder of exports, labelled an estimate", async () => {
    const out = await scan(fixtures);
    expect(out).toContain("Hotpath savings scan (estimate)");
    expect(out).toContain("Runs scanned:");
    expect(out).toContain("Nothing was sent anywhere");
    expect(out).not.toContain("ana@example.com");
  });

  it("prints JSON with --json and writes one HTML file with --html", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scan-cli-"));
    const html = path.join(dir, "report.html");
    const json = JSON.parse(
      await scan(
        path.join(fixtures, "langsmith.json"),
        "--json",
        "--html",
        html,
      ),
    ) as { label: string; runs: number };
    expect(json).toMatchObject({ label: "estimate", runs: 1 });
    const page = await readFile(html, "utf8");
    expect(page).toContain("<!doctype html>");
    expect(page).not.toMatch(/src="http|href="http/);
  });

  it("fails with a message that says what to do for a missing path", async () => {
    await expect(scan(path.join(fixtures, "nope"))).rejects.toThrow(
      /trace export file or a folder/,
    );
  });
});
