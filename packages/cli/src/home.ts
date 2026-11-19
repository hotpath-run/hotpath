import path from "node:path";

/**
 * `hotpath --home <dir> <command…>`: use <dir> as the project folder. It must be
 * the first argument, and it is read before anything else is loaded, because
 * the folders (traces/, workflows/, .hotpath/) are fixed when the modules load.
 * `hotpath wrap` writes it into the agent's config: the agent starts the
 * recorder from its own folder, which is not the project.
 */
export function applyHomeFlag(
  argv: string[],
  env: Record<string, string | undefined>,
): void {
  const first = argv[2];
  const dir =
    first === "--home"
      ? argv[3]
      : first?.startsWith("--home=")
        ? first.slice("--home=".length)
        : undefined;
  if (dir) env.HOTPATH_HOME = path.resolve(dir);
}
