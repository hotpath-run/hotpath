import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// The fuzzer is not part of `pnpm test`: run it with `pnpm fuzz`.
export default defineConfig({
  test: {
    include: ["fuzz/**/*.fuzz.ts"],
    testTimeout: 3_600_000,
    // replays write out/hotpath-run.json in the project folder, read when the
    // runtime loads: its own folder means a fuzz run never overwrites what the
    // test suite is reading at the same time
    env: { HOTPATH_HOME: mkdtempSync(path.join(os.tmpdir(), "hotpath-fuzz-")) },
  },
});
