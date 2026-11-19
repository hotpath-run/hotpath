import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { projectRoot, runningFromSource } from "@hotpathrun/shared";

const thisFile = fileURLToPath(import.meta.url);
const here = path.dirname(thisFile);

/** The project folder (the repository in a checkout). */
export const repoRoot = projectRoot();

export interface SelfOptions {
  /** an installed build: `file` is the bundle itself */
  installed: boolean;
  /** this module's file */
  file: string;
  /** the Node binary */
  node: string;
  /** the project folder */
  home: string;
  /** tsx's cli, only needed from TypeScript source */
  tsx?: () => string;
}

/**
 * argv that starts this CLI from anywhere (an agent launches it from its own
 * folder).
 * - Installed: the Node binary, the bundled file, and `--home <project>` so the
 *   recorder still finds the project; the command keeps working when the
 *   checkout it was built from is gone.
 * - From source: the Node binary, then tsx when running TypeScript, then the
 *   entry file.
 */
export function selfCommandFor(options: SelfOptions): string[] {
  if (options.installed) {
    return [options.node, options.file, "--home", options.home];
  }
  const dir = path.dirname(options.file);
  const fromTs = options.file.endsWith(".ts");
  const entry = path.join(dir, "..", fromTs ? "index.ts" : "index.js");
  if (!fromTs) return [options.node, entry];
  return [options.node, options.tsx!(), entry];
}

export function selfCommand(): string[] {
  return selfCommandFor({
    installed: !runningFromSource(),
    file: thisFile,
    node: process.execPath,
    home: repoRoot,
    tsx: () => {
      // prefer the stable node_modules/tsx path over the versioned .pnpm store path
      const stable = path.join(
        here,
        "../../../..",
        "node_modules",
        "tsx",
        "dist",
        "cli.mjs",
      );
      return existsSync(stable)
        ? stable
        : createRequire(import.meta.url).resolve("tsx/cli");
    },
  });
}
