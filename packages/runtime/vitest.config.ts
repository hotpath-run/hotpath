import { defineConfig } from "vitest/config";

// Several test files start the demo tool server, which writes out/messages.json
// in the repository; one test checks that a dry run leaves it absent. Run the
// files one after another so they cannot see each other's messages.
export default defineConfig({
  test: { fileParallelism: false },
});
