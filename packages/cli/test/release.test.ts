// `npm pack` of @hotpathrun/cli makes one file that `npm i -g` installs,
// and the installed `hotpath` works with no checkout, tsx or pnpm around it.
// The test builds into a temp folder, installs into a temp prefix and runs the
// commands from a temp project (all with a space and an accent in the path).
import crossSpawn from "cross-spawn";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const fixtureTrace = path.join(
  repoRoot,
  "packages/compiler/test/fixtures/morning-brief.jsonl",
);

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, { cwd, env });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
}

let tmp: string;
let project: string;
let hotpathBin: string;
let version: string;

// The installed command must not lean on this checkout's settings.
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(HOTPATH_|LLM_|MOONSHOT_|PRICE_)/.test(key)) delete env[key];
  }
  // the installed command needs an account: a test token (no network), and no sync
  env.HOTPATH_TOKEN = ["hp", "test", "release", "test"].join("_");
  env.HOTPATH_NO_SYNC = "1";
  // never the real sign-in of whoever runs the tests
  env.HOTPATH_CREDENTIALS_DIR = path.join(tmp, "credentials");
  return env;
};

const hotpath = (args: string[], cwd = project) =>
  run(hotpathBin, args, cwd, cleanEnv());

beforeAll(async () => {
  // real path: wrap reports resolved paths, and the temp folder sits behind a
  // link on macOS (/var -> /private/var) and on Windows CI (RUNNER~1)
  tmp = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "hotpath release é-")),
  );
  project = path.join(tmp, "my project");
  await mkdir(project, { recursive: true });
  const out = path.join(tmp, "out");
  const prefix = path.join(tmp, "prefix");
  await mkdir(prefix, { recursive: true });
  version = (
    JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;

  // the real package: npm runs its prepack step (scripts/build-cli.mjs), which
  // bundles the CLI, builds the viewer and copies the demo data
  await mkdir(out, { recursive: true });
  const built = await run(
    "npm",
    ["pack", "--pack-destination", out, "--silent"],
    path.join(repoRoot, "packages/cli"),
  );
  expect(built.code, built.out).toBe(0);
  const tarball = path.join(out, `hotpathrun-cli-${version}.tgz`);
  expect(existsSync(tarball)).toBe(true);

  const installed = await run(
    "npm",
    ["i", "-g", "--prefix", prefix, "--no-audit", "--no-fund", tarball],
    tmp,
  );
  expect(installed.code, installed.out).toBe(0);
  // npm puts the command in <prefix> on Windows and <prefix>/bin elsewhere
  hotpathBin =
    process.platform === "win32"
      ? path.join(prefix, "hotpath.cmd")
      : path.join(prefix, "bin", "hotpath");
  expect(existsSync(hotpathBin)).toBe(true);
}, 300_000);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("installed hotpath", () => {
  it("--version prints the version from package.json", async () => {
    const result = await hotpath(["--version"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out.trim()).toBe(version);
  }, 60_000);

  it("init and doctor work in a folder that is not a checkout", async () => {
    const init = await hotpath(["init", "--provider", "ollama", "--yes"]);
    expect(init.code, init.out).toBe(0);
    expect(existsSync(path.join(project, ".env"))).toBe(true);

    const doctor = await hotpath(["doctor", "--offline"]);
    expect(doctor.out).toContain("Settings");
    expect(doctor.out).toContain(path.join(project, ".env"));
    expect(doctor.code, doctor.out).toBe(0);
  }, 60_000);

  it("compiles the fixture trace into the project's workflows folder", async () => {
    const compiled = await hotpath([
      "compile",
      "morning-brief",
      "--trace",
      fixtureTrace,
    ]);
    expect(compiled.code, compiled.out).toBe(0);
    expect(compiled.out).toContain("compiled 5 steps");
    const workflow = JSON.parse(
      await readFile(
        path.join(project, "workflows", "morning-brief.json"),
        "utf8",
      ),
    ) as { steps: unknown[] };
    expect(workflow.steps).toHaveLength(5);

    const shown = await hotpath(["show", "morning-brief"]);
    expect(shown.out).toContain("s5 tool send_message");
  }, 60_000);

  it("finds the project from a subfolder, and from anywhere with --home", async () => {
    const sub = path.join(project, "notes", "deep");
    await mkdir(sub, { recursive: true });
    const fromSub = await hotpath(["show", "morning-brief"], sub);
    expect(fromSub.code, fromSub.out).toBe(0);

    const fromElsewhere = await hotpath(
      ["--home", project, "show", "morning-brief"],
      tmp,
    );
    expect(fromElsewhere.code, fromElsewhere.out).toBe(0);
    expect(fromElsewhere.out).toContain("s1 tool get_emails");
  }, 60_000);

  it("wrap writes a command that exists and still points at this project", async () => {
    const config = path.join(project, ".cursor", "mcp.json");
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(
      config,
      JSON.stringify(
        { mcpServers: { files: { command: "node", args: ["server.js"] } } },
        null,
        2,
      ),
    );
    const wrapped = await hotpath([
      "wrap",
      "cursor",
      "files",
      "--task",
      "brief",
    ]);
    expect(wrapped.code, wrapped.out).toBe(0);
    const entry = (
      JSON.parse(await readFile(config, "utf8")) as {
        mcpServers: { files: { command: string; args: string[] } };
      }
    ).mcpServers.files;
    // the Node binary, then the installed file: neither is in this checkout
    expect(existsSync(entry.command)).toBe(true);
    expect(existsSync(entry.args[0]!)).toBe(true);
    expect(path.resolve(entry.args[0]!).startsWith(repoRoot + path.sep)).toBe(
      false,
    );
    expect(entry.args.slice(1)).toEqual([
      "--home",
      project,
      "record",
      "--task",
      "brief",
      "--",
      "node",
      "server.js",
    ]);

    const unwrapped = await hotpath(["unwrap", "cursor", "files"]);
    expect(unwrapped.code, unwrapped.out).toBe(0);
  }, 60_000);

  it("the package holds the bundle and the viewer, and no source", async () => {
    const pkgDir = path.dirname(
      path.dirname(
        // hotpath.cmd / bin/hotpath → …/node_modules/hotpath/dist/hotpath.mjs
        (
          await hotpath([
            "--home",
            project,
            "wrap",
            "cursor",
            "files",
            "--task",
            "x",
            "--dry-run",
          ])
        ).out
          .split("\n")
          .map((l) => l.replace(/^[+\s"]+|[",\s]+$/g, ""))
          .find((l) => l.endsWith("hotpath.mjs"))!
          .replace(/\\\\/g, "\\"),
      ),
    );
    expect((await readdir(pkgDir)).sort()).toEqual([
      "LICENSE",
      "demo",
      "dist",
      "package.json",
      "viewer",
    ]);
    expect(await readdir(path.join(pkgDir, "dist"))).toEqual(["hotpath.mjs"]);
    expect(existsSync(path.join(pkgDir, "viewer", "index.html"))).toBe(true);
    for (const set of ["default", "new-data"]) {
      expect(
        existsSync(path.join(pkgDir, "demo", "fixtures", set, "emails.json")),
      ).toBe(true);
    }
  }, 60_000);

  // Claude Code (or any MCP client) starts `hotpath demo-tools` on its own, with
  // none of the settings `hotpath demo` passes: it must still find its data and
  // write what it "sends" into the project folder.
  it("demo-tools works when an MCP client starts it directly", async () => {
    const calls = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "release-test", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_emails", arguments: { date: "2026-10-01" } },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "send_message",
          arguments: { to: "me", text: "release test" },
        },
      },
    ];
    const replies = await new Promise<
      Array<{
        id?: number;
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      }>
    >((resolve, reject) => {
      const child = crossSpawn(hotpathBin, ["demo-tools"], {
        cwd: project,
        env: cleanEnv(),
      });
      let out = "";
      let err = "";
      const got: Array<{ id?: number }> = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`no answer in time; stderr: ${err}`));
      }, 30_000);
      child.stderr?.on("data", (d) => (err += d));
      child.stdout?.on("data", (d) => {
        out += d;
        let nl: number;
        while ((nl = out.indexOf("\n")) >= 0) {
          const line = out.slice(0, nl).trim();
          out = out.slice(nl + 1);
          if (!line) continue;
          got.push(JSON.parse(line) as { id?: number });
          if (got.some((g) => g.id === 3)) {
            clearTimeout(timer);
            child.kill();
            resolve(got as never);
          }
        }
      });
      child.on("error", reject);
      for (const c of calls) child.stdin?.write(JSON.stringify(c) + "\n");
    });
    const emails = replies.find((r) => r.id === 2)?.result;
    expect(emails?.isError, JSON.stringify(emails)).not.toBe(true);
    expect(emails?.content?.[0]?.text).toMatch(/"emails":\[\{/);
    const sent = replies.find((r) => r.id === 3)?.result;
    expect(sent?.isError, JSON.stringify(sent)).not.toBe(true);
    const messages = JSON.parse(
      await readFile(path.join(project, "out", "messages.json"), "utf8"),
    ) as Array<{ text: string }>;
    expect(messages.map((m) => m.text)).toContain("release test");
  }, 60_000);

  it("hotpath demo says what to do first, and refuses too few runs", async () => {
    const few = await hotpath(["demo", "--runs", "2"]);
    expect(few.code).toBe(1);
    expect(few.out).toMatch(/at least 3/);

    const bare = await mkdtemp(path.join(tmp, "bare-"));
    const noModel = await hotpath(["demo"], bare);
    expect(noModel.code).toBe(1);
    expect(noModel.out).toMatch(/hotpath init/);
  }, 60_000);
});
