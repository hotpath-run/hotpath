// `hotpath wrap` for Cursor, Claude Desktop and VS Code: the same entry shape
// as Claude Code in different files. Every test works in a temp folder.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeDesktopConfigPath } from "../src/wrap/agents.js";
import { unwrap, wrap } from "../src/wrap/wrap.js";

const SELF = ["/usr/bin/node", "/opt/hotpath/packages/cli/src/index.ts"];
const stdio = {
  type: "stdio",
  command: "node",
  args: ["/tools/demo.js"],
  env: { K: "v" },
};

let dir: string;
let home: string;
let proj: string;
let stateDir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hotpath-wrap-agents-"));
  home = path.join(dir, "home");
  proj = path.join(dir, "proj");
  stateDir = path.join(dir, ".hotpath");
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
const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const wrapped = (task: string) => ({
  ...stdio,
  command: SELF[0],
  args: [SELF[1], "record", "--task", task, "--", "node", "/tools/demo.js"],
});

describe("wrap / unwrap cursor", () => {
  it("wraps a server in ~/.cursor/mcp.json and unwrap restores the file byte for byte", async () => {
    const file = path.join(home, ".cursor", "mcp.json");
    const original = await writeJson(file, {
      mcpServers: { demo: stdio, other: { command: "x" } },
    });
    const result = await wrap({
      agent: "cursor",
      server: "demo",
      task: "cur",
      home,
      cwd: proj,
      stateDir,
      self: SELF,
    });
    expect(result.file).toBe(file);
    expect(result.reloadHint).toMatch(/Cursor/);
    const after = await read(file);
    expect(after.mcpServers.demo).toEqual(wrapped("cur"));
    expect(after.mcpServers.other).toEqual({ command: "x" });

    await unwrap({
      agent: "cursor",
      server: "demo",
      home,
      cwd: proj,
      stateDir,
    });
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("prefers the project's .cursor/mcp.json, like Cursor does", async () => {
    const user = path.join(home, ".cursor", "mcp.json");
    const project = path.join(proj, ".cursor", "mcp.json");
    await writeJson(user, { mcpServers: { demo: stdio } });
    await writeJson(project, {
      mcpServers: { demo: { command: "project-cmd" } },
    });
    const result = await wrap({
      agent: "cursor",
      server: "demo",
      task: "t",
      home,
      cwd: proj,
      stateDir,
      self: SELF,
    });
    expect(result.file).toBe(project);
    expect((await read(project)).mcpServers.demo.args).toContain("project-cmd");
    expect((await read(user)).mcpServers.demo).toEqual(stdio);
  });

  it("--scope user skips the project file", async () => {
    const user = path.join(home, ".cursor", "mcp.json");
    await writeJson(user, { mcpServers: { demo: stdio } });
    await writeJson(path.join(proj, ".cursor", "mcp.json"), {
      mcpServers: { demo: { command: "p" } },
    });
    const result = await wrap({
      agent: "cursor",
      server: "demo",
      task: "t",
      home,
      cwd: proj,
      scope: "user",
      stateDir,
      self: SELF,
    });
    expect(result.file).toBe(user);
  });

  it("--scope local is refused: that is a Claude Code scope", async () => {
    await writeJson(path.join(home, ".cursor", "mcp.json"), {
      mcpServers: { demo: stdio },
    });
    await expect(
      wrap({
        agent: "cursor",
        server: "demo",
        task: "t",
        home,
        cwd: proj,
        scope: "local",
        stateDir,
        self: SELF,
      }),
    ).rejects.toThrow(/--scope local is for claude-code only/);
  });

  it("says where it looked when there is no config", async () => {
    await expect(
      wrap({
        agent: "cursor",
        server: "demo",
        task: "t",
        home,
        cwd: proj,
        stateDir,
        self: SELF,
      }),
    ).rejects.toThrow(/no cursor MCP config found \(looked for .*mcp\.json/);
  });

  it("refuses a file with comments instead of losing them", async () => {
    const file = path.join(home, ".cursor", "mcp.json");
    await mkdir(path.dirname(file), { recursive: true });
    const text =
      '{\n  // my servers\n  "mcpServers": { "demo": { "command": "node" } }\n}\n';
    await writeFile(file, text);
    await expect(
      wrap({
        agent: "cursor",
        server: "demo",
        task: "t",
        home,
        cwd: proj,
        stateDir,
        self: SELF,
      }),
    ).rejects.toThrow(/comments or trailing commas/);
    expect(await readFile(file, "utf8")).toBe(text);
  });
});

describe("wrap / unwrap claude-desktop", () => {
  it("finds the config in each OS's documented folder", () => {
    expect(
      claudeDesktopConfigPath({ home: "/h", platform: "darwin", env: {} }),
    ).toBe(
      path.join(
        "/h",
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      ),
    );
    expect(
      claudeDesktopConfigPath({
        home: "/h",
        platform: "win32",
        env: { APPDATA: "/appdata" },
      }),
    ).toBe(path.join("/appdata", "Claude", "claude_desktop_config.json"));
    expect(
      claudeDesktopConfigPath({ home: "/h", platform: "linux", env: {} }),
    ).toBe(path.join("/h", ".config", "Claude", "claude_desktop_config.json"));
  });

  it("wraps and restores a server, keeping the rest of the file", async () => {
    const appdata = path.join(dir, "appdata");
    const file = path.join(appdata, "Claude", "claude_desktop_config.json");
    const original = await writeJson(file, {
      globalShortcut: "Ctrl+Space",
      mcpServers: { demo: stdio },
    });
    const opts = {
      home,
      cwd: proj,
      stateDir,
      platform: "win32" as const,
      env: { APPDATA: appdata },
    };
    const result = await wrap({
      agent: "claude-desktop",
      server: "demo",
      task: "desk",
      self: SELF,
      ...opts,
    });
    expect(result.file).toBe(file);
    expect(result.reloadHint).toMatch(/Quit Claude Desktop/);
    const after = await read(file);
    expect(after.mcpServers.demo).toEqual(wrapped("desk"));
    expect(after.globalShortcut).toBe("Ctrl+Space");

    await unwrap({ agent: "claude-desktop", server: "demo", ...opts });
    expect(await readFile(file, "utf8")).toBe(original);
  });
});

describe("wrap / unwrap vscode", () => {
  it("wraps a server in the workspace .mcp.json (Copilot's native file)", async () => {
    const file = path.join(proj, ".mcp.json");
    const original = await writeJson(file, { mcpServers: { demo: stdio } });
    const result = await wrap({
      agent: "vscode",
      server: "demo",
      task: "vs",
      home,
      cwd: proj,
      stateDir,
      self: SELF,
    });
    expect(result.file).toBe(file);
    expect((await read(file)).mcpServers.demo).toEqual(wrapped("vs"));
    await unwrap({
      agent: "vscode",
      server: "demo",
      home,
      cwd: proj,
      stateDir,
    });
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("handles the older .vscode/mcp.json, whose map is called servers", async () => {
    const file = path.join(proj, ".vscode", "mcp.json");
    const original = await writeJson(file, {
      inputs: [],
      servers: { demo: stdio },
    });
    const result = await wrap({
      agent: "vscode",
      server: "demo",
      task: "vs",
      home,
      cwd: proj,
      stateDir,
      self: SELF,
    });
    expect(result.file).toBe(file);
    const after = await read(file);
    expect(after.servers.demo).toEqual(wrapped("vs"));
    expect(after.inputs).toEqual([]);
    await unwrap({
      agent: "vscode",
      server: "demo",
      home,
      cwd: proj,
      stateDir,
    });
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("uses ~/.copilot/mcp-config.json (or COPILOT_HOME) for user servers", async () => {
    const copilot = path.join(dir, "copilot-home");
    const file = path.join(copilot, "mcp-config.json");
    await writeJson(file, { mcpServers: { demo: stdio } });
    const result = await wrap({
      agent: "vscode",
      server: "demo",
      task: "vs",
      home,
      cwd: proj,
      stateDir,
      self: SELF,
      env: { COPILOT_HOME: copilot },
    });
    expect(result.file).toBe(file);
  });

  it("lists the servers it found when the name is wrong", async () => {
    await writeJson(path.join(proj, ".mcp.json"), {
      mcpServers: { files: stdio },
    });
    await writeJson(path.join(proj, ".vscode", "mcp.json"), {
      servers: { github: stdio },
    });
    await expect(
      wrap({
        agent: "vscode",
        server: "nope",
        task: "t",
        home,
        cwd: proj,
        stateDir,
        self: SELF,
      }),
    ).rejects.toThrow(/servers found: files, github/);
  });
});

describe("unknown agents", () => {
  it("lists every agent Hotpath can wrap", async () => {
    await expect(
      wrap({
        agent: "zed",
        server: "demo",
        task: "t",
        home,
        cwd: proj,
        stateDir,
        self: SELF,
      }),
    ).rejects.toThrow(
      /use one of: claude-code, cursor, claude-desktop, vscode, openclaw/,
    );
    await expect(
      unwrap({ agent: "zed", server: "demo", home, cwd: proj, stateDir }),
    ).rejects.toThrow(/use one of/);
  });
});
