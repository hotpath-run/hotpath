// Security finding 7: traces hold the tools' real data and stayed forever.
// With HOTPATH_RETAIN_DAYS=N, saving a workflow deletes that task's traces
// older than N days, except the one the workflow was compiled from (the
// workflow keeps one example of the data anyway). Off unless set: deleting
// recordings changes what a later compile can learn from (branches).
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** N from HOTPATH_RETAIN_DAYS, or null when unset or not a positive number. */
export function retainDays(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const n = Number(env.HOTPATH_RETAIN_DAYS);
  return env.HOTPATH_RETAIN_DAYS && Number.isFinite(n) && n > 0 ? n : null;
}

/** Deletes `*.jsonl` traces in `dir` older than `days`, never `keep`. Returns the names deleted. */
export async function pruneTraces(
  dir: string,
  keep: string,
  days: number,
  now = Date.now(),
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // no traces for this task
  }
  const deleted: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl") || name === keep) continue;
    const file = path.join(dir, name);
    const { mtimeMs } = await stat(file);
    if (now - mtimeMs > days * 86_400_000) {
      await rm(file, { force: true });
      deleted.push(name);
    }
  }
  return deleted;
}
