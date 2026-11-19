import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// The CLI's tests run commands that the login requirement gates and that would
// sync: give them a test token and turn sync off. Tests of the gate and of sync
// pass their own environment and a fake fetch; nothing here reaches the network.
// The sign-in folder and the home folder are throwaway ones: a test must never
// read, move or delete the real sign-in of the person running the tests (it did
// once, before this).
const sandbox = path.join(os.tmpdir(), `hotpath-cli-tests-${process.pid}`);

export default defineConfig({
  test: {
    env: {
      HOTPATH_TOKEN: ["hp", "test", "cli", "tests"].join("_"),
      HOTPATH_NO_SYNC: "1",
      HOTPATH_CREDENTIALS_DIR: path.join(sandbox, "credentials"),
    },
  },
});
