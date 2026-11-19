import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every action of the triage demo tools, in order, in the repo's out/ folder
// (whether run from src/ with tsx or from dist/ with node). The benchmark reads
// it to check that each email got the right treatment.
const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../out",
);
const actionsFile = path.join(outDir, "actions.json");

export interface Action {
  /** order of the action in out/actions.json (the payload keeps its own `id`) */
  seq: number;
  kind: string;
  [key: string]: unknown;
}

export async function appendAction(
  action: Record<string, unknown> & { kind: string },
): Promise<Action> {
  await mkdir(outDir, { recursive: true });
  let actions: Action[] = [];
  try {
    actions = JSON.parse(await readFile(actionsFile, "utf8"));
  } catch {
    // first action
  }
  const done: Action = { ...action, seq: actions.length + 1 };
  actions.push(done);
  await writeFile(actionsFile, JSON.stringify(actions, null, 2));
  return done;
}
