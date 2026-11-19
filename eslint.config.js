import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "traces/**",
      "workflows/**",
      "out/**",
      "site/.astro/**",
      "release/**",
      // built by the CLI package's prepack step (scripts/build-cli.mjs)
      "packages/cli/viewer/**",
      "packages/cli/demo/**",
      "hotpath-report-*/**",
    ],
  },
);
