// How `hotpath wrap` and `hotpath daemon install` start this CLI again later.
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createProgram } from "../src/program.js";
import { applyHomeFlag } from "../src/home.js";
import { selfCommand, selfCommandFor } from "../src/wrap/self.js";

describe("selfCommand", () => {
  it("installed: the Node binary, the bundle, and --home <project>", () => {
    const bundle = path.join("/usr/lib/node_modules/hotpath/dist/hotpath.mjs");
    expect(
      selfCommandFor({
        installed: true,
        file: bundle,
        node: "/usr/bin/node",
        home: "/home/me/my project",
      }),
    ).toEqual(["/usr/bin/node", bundle, "--home", "/home/me/my project"]);
  });

  it("from TypeScript source: node, tsx, the entry file", () => {
    const file = path.join("/repo/packages/cli/src/wrap/self.ts");
    expect(
      selfCommandFor({
        installed: false,
        file,
        node: "/usr/bin/node",
        home: "/repo",
        tsx: () => "/repo/node_modules/tsx/dist/cli.mjs",
      }),
    ).toEqual([
      "/usr/bin/node",
      "/repo/node_modules/tsx/dist/cli.mjs",
      path.join("/repo/packages/cli/src/index.ts"),
    ]);
  });

  it("from built JavaScript: node and the entry file", () => {
    const file = path.join("/repo/packages/cli/dist/wrap/self.js");
    expect(
      selfCommandFor({
        installed: false,
        file,
        node: "/usr/bin/node",
        home: "/repo",
      }),
    ).toEqual(["/usr/bin/node", path.join("/repo/packages/cli/dist/index.js")]);
  });

  it("in this checkout it points at files that exist", async () => {
    const { existsSync } = await import("node:fs");
    for (const part of selfCommand()) expect(existsSync(part), part).toBe(true);
  });
});

describe("--home", () => {
  it("as the first argument sets the project folder, resolved", () => {
    const env: Record<string, string | undefined> = {};
    applyHomeFlag(["node", "hotpath", "--home", "some/dir", "show", "t"], env);
    expect(env.HOTPATH_HOME).toBe(path.resolve("some/dir"));

    const env2: Record<string, string | undefined> = {};
    applyHomeFlag(["node", "hotpath", "--home=/x y", "show", "t"], env2);
    expect(env2.HOTPATH_HOME).toBe(path.resolve("/x y"));
  });

  it("anywhere else it belongs to the command (a server's own --home)", () => {
    const env: Record<string, string | undefined> = {};
    applyHomeFlag(
      ["node", "hotpath", "record", "--task", "t", "--", "srv", "--home", "/s"],
      env,
    );
    expect(env.HOTPATH_HOME).toBeUndefined();
  });

  it("is listed in --help, with --version", () => {
    const help = createProgram().helpInformation();
    expect(help).toContain("--home <dir>");
    expect(help).toContain("--version");
  });
});
