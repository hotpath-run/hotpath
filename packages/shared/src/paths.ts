import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where a Hotpath project lives: the folder that holds traces/, workflows/,
// out/, .hotpath/, .env and hotpath.config.json. In a source checkout that is
// the repository; an installed `hotpath` has no repository, so it is the folder
// the user works in.

const here = path.dirname(fileURLToPath(import.meta.url));

/** The repository root when this file runs from a checkout, else null. */
export function sourceRoot(file: string = here): string | null {
  const match = /^(.*)[\\/]packages[\\/]shared[\\/](?:src|dist)$/.exec(file);
  return match ? match[1]! : null;
}

/** Files that mark a folder as a Hotpath project. */
const MARKERS = [".hotpath", "hotpath.config.json"];

/** The nearest folder at or above `start` that holds a marker, else null. */
export function findProject(
  start: string,
  exists: (file: string) => boolean = existsSync,
): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (MARKERS.some((m) => exists(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface ProjectRootOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** null = not running from a checkout (an installed build) */
  source?: string | null;
  exists?: (file: string) => boolean;
}

/**
 * 1. HOTPATH_HOME (also set by `hotpath --home <dir>`: a wrapped agent starts
 *    the recorder from its own folder and must still find the project);
 * 2. the repository, when running from a checkout (as it always was);
 * 3. the nearest folder above the working folder with .hotpath/ or
 *    hotpath.config.json, else the working folder itself.
 */
export function resolveProjectRoot(options: ProjectRootOptions = {}): string {
  const env = options.env ?? process.env;
  const home = env.HOTPATH_HOME?.trim();
  if (home) return path.resolve(home);
  const source = options.source === undefined ? sourceRoot() : options.source;
  if (source) return source;
  const cwd = options.cwd ?? process.cwd();
  return findProject(cwd, options.exists) ?? path.resolve(cwd);
}

let cached: string | undefined;

/** The project folder for this process (resolved once). */
export function projectRoot(): string {
  cached ??= resolveProjectRoot();
  return cached;
}

/** True when the code runs from a source checkout (tsx or a package build). */
export function runningFromSource(): boolean {
  return sourceRoot() !== null;
}
