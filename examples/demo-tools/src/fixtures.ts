import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// DEMO_FIXTURES_DIR: the installed CLI ships a few fixtures next to its bundle.
const fixturesDir =
  process.env.DEMO_FIXTURES_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

export async function loadFixture<T = Record<string, unknown>>(
  name: string,
): Promise<T> {
  const set = process.env.DEMO_FIXTURES ?? "default";
  const file = path.join(fixturesDir, set, `${name}.json`);
  return JSON.parse(await readFile(file, "utf8"));
}
