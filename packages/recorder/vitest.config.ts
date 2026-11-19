import { defineConfig } from "vitest/config";

// Every recorder test starts real node processes (the recorder and a tool
// server); a cold Windows CI runner has taken over 5 s for one of them.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
