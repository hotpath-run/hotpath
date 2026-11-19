import { defineConfig } from "vitest/config";

// The test starts the CLI's recorder, which needs an account like every command;
// a test token is enough (nothing here reaches the network, and sync is off).
export default defineConfig({
  test: {
    env: {
      HOTPATH_TOKEN: ["hp", "test", "demo", "agent", "tests"].join("_"),
      HOTPATH_NO_SYNC: "1",
    },
  },
});
