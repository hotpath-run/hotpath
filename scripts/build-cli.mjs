// Builds what the CLI package ships, into <dir> (default packages/cli):
//   dist/hotpath.mjs      the CLI and everything it needs as one ES module
//   viewer/               the workflow viewer as static files
//   demo/fixtures/        the data `hotpath demo` uses
// `pnpm pack` / `pnpm publish` of @hotpathrun/cli runs this as its prepack step;
// scripts/release-build.mjs reuses buildCli for the private release tarball.
/* global process, console */
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function buildCli(dir) {
  await mkdir(path.join(dir, "dist"), { recursive: true });
  await build({
    entryPoints: [path.join(repoRoot, "packages/cli/src/index.ts")],
    outfile: path.join(dir, "dist", "hotpath.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Only the dev viewer needs these; the release serves the built viewer.
    external: ["vite", "@vitejs/plugin-react"],
    banner: {
      // some bundled dependencies are CommonJS and call require() for Node built-ins
      js: [
        "#!/usr/bin/env node",
        'import { createRequire as __hotpathCreateRequire } from "node:module";',
        "const require = __hotpathCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    legalComments: "none",
    logLevel: "warning",
  });

  const viewerRoot = path.join(repoRoot, "packages/viewer");
  const viewerRequire = createRequire(path.join(viewerRoot, "package.json"));
  const vite = await import(pathToFileURL(viewerRequire.resolve("vite")).href);
  const react = (
    await import(
      pathToFileURL(viewerRequire.resolve("@vitejs/plugin-react")).href
    )
  ).default;
  await vite.build({
    root: viewerRoot,
    configFile: false,
    logLevel: "warn",
    plugins: [react()],
    build: { outDir: path.join(dir, "viewer"), emptyOutDir: true },
  });

  // the demo's data: the three files the morning-brief tools read
  const demo = path.join(dir, "demo", "fixtures");
  await rm(path.join(dir, "demo"), { recursive: true, force: true });
  for (const set of ["default", "new-data"]) {
    await mkdir(path.join(demo, set), { recursive: true });
    for (const name of ["emails", "calendar", "weather"]) {
      await cp(
        path.join(
          repoRoot,
          "examples/demo-tools/fixtures",
          set,
          `${name}.json`,
        ),
        path.join(demo, set, `${name}.json`),
      );
    }
  }
  await cp(path.join(repoRoot, "LICENSE"), path.join(dir, "LICENSE"));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const dir = path.resolve(process.cwd());
  buildCli(dir).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
