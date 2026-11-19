// task 07: `hotpath wrap` with a home folder, a project, a config file
// and a server path that hold spaces and non-ASCII letters, as on a Windows
// account named "Zoé Müller". Every part must come back out exactly as it went
// in: the agent runs the command from an argument list.
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeDesktopConfigPath } from "../src/wrap/agents.js";
import { unwrap, wrap } from "../src/wrap/wrap.js";

let dir: string;
let home: string;
let proj: string;
let stateDir: string;
let self: string[];
let server: { command: string; args: string[]; env: Record<string, string> };

beforeEach(async () => {
  // real path: wrap reports resolved paths, and the temp folder sits behind a
  // link on macOS (/var -> /private/var) and on Windows CI (RUNNER~1)
  dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "hotpath Zoé Müller 日本-")),
  );
  home = path.join(dir, "Users", "Zoé Müller");
  proj = path.join(home, "My Projects", "café app");
  stateDir = path.join(proj, ".hotpath");
  self = [
    path.join(dir, "Program Files", "nodejs", "node.exe"),
    path.join(home, "AppData", "npm global", "hotpath", "dist", "hotpath.mjs"),
    "--home",
    proj,
  ];
  server = {
    command: path.join(dir, "Program Files", "nodejs", "node.exe"),
    args: [
      path.join(home, "My Tools (v2)", "démo server.mjs"),
      "--mode",
      "a b",
    ],
    env: { TOKEN: "${TOKEN}" },
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeJson(file: string, data: unknown): Promise<string> {
  const text = JSON.stringify(data, null, 2) + "\n";
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return text;
}

describe("wrap with spaces and non-ASCII letters in every path", () => {
  for (const agent of ["cursor", "vscode", "claude-desktop"] as const) {
    it(`${agent}: wraps, keeps every argument whole, and unwrap restores the file`, async () => {
      const env = { APPDATA: path.join(home, "AppData", "Roaming") };
      const file =
        agent === "cursor"
          ? path.join(proj, ".cursor", "mcp.json")
          : agent === "vscode"
            ? path.join(proj, ".mcp.json")
            : claudeDesktopConfigPath({ home, env });
      const original = await writeJson(file, { mcpServers: { démo: server } });
      const options = { agent, server: "démo", home, cwd: proj, stateDir, env };

      const result = await wrap({ ...options, task: "brief", self });
      expect(result.file).toBe(file);
      const entry = (
        JSON.parse(await readFile(file, "utf8")) as {
          mcpServers: Record<string, typeof server>;
        }
      ).mcpServers["démo"]!;
      expect(entry.command).toBe(self[0]);
      expect(entry.args).toEqual([
        ...self.slice(1),
        "record",
        "--task",
        "brief",
        "--",
        server.command,
        ...server.args,
      ]);
      expect(entry.env).toEqual(server.env);

      await unwrap(options);
      expect(await readFile(file, "utf8")).toBe(original);
    });
  }
});
