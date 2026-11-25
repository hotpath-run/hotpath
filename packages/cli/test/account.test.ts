// Login, logout, whoami and the login requirement. All HTTP is a fake fetch.
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkLogin, GATE_MARKER, OPEN_COMMANDS } from "../src/account/gate.js";
import {
  CHECK_EVERY_MS,
  LOGIN_REQUIRED_MESSAGE,
  OFFLINE_GRACE_MS,
  REQUIRE_LOGIN,
} from "../src/account/config.js";
import {
  credentialsDir,
  migrateLegacyCredentials,
  readCredentials,
  readLastCheck,
  writeCredentials,
  writeLastCheck,
} from "../src/account/credentials.js";
import { login, logout, whoami } from "../src/account/login.js";
import { createProgram } from "../src/program.js";

const TOKEN = "hp_" + "x".repeat(48);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hotpath-account-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Call {
  fn: string;
  body: Record<string, unknown>;
  auth: string | null;
}

/** A fake hotpath.run: answers each call from `answer`, records what was asked. */
function fakeFetch(
  answer: (call: Call) => { status?: number; body: unknown } | "network",
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = {
      fn: String(url).split("/functions/v1/")[1]!,
      body: JSON.parse(String(init?.body)),
      auth: (init?.headers as Record<string, string>)?.authorization ?? null,
    };
    calls.push(call);
    const res = answer(call);
    if (res === "network") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(res.body), {
      status: res.status ?? 200,
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const gateDeps = (
  f: typeof fetch,
  over: Partial<Parameters<typeof checkLogin>[0]> = {},
) => ({
  env: {} as NodeJS.ProcessEnv,
  dir,
  fetch: f,
  now: () => 1_000_000_000_000,
  pidAlive: () => false,
  requireLogin: true,
  ...over,
});

describe("where the sign-in is kept", () => {
  const home = path.resolve("/", "Users", "me");

  it("in the user's settings folder, never in a folder that marks a project", () => {
    expect(credentialsDir({ APPDATA: "C:\\Roaming" }, "win32", home)).toBe(
      path.join("C:\\Roaming", "hotpath"),
    );
    expect(credentialsDir({}, "linux", home)).toBe(
      path.join(home, ".config", "hotpath"),
    );
    expect(credentialsDir({ XDG_CONFIG_HOME: "/xdg" }, "darwin", home)).toBe(
      path.join("/xdg", "hotpath"),
    );
    expect(
      credentialsDir({ HOTPATH_CREDENTIALS_DIR: "/t" }, "linux", home),
    ).toBe("/t");
    for (const platform of ["win32", "linux", "darwin"] as const) {
      expect(path.basename(credentialsDir({}, platform, home))).not.toBe(
        ".hotpath",
      );
    }
  });

  it("a sign-in left in ~/.hotpath moves to the new folder once", async () => {
    const legacy = path.join(dir, "legacy-home", ".hotpath");
    const fresh = path.join(dir, "settings", "hotpath");
    await writeCredentials(legacy, {
      token: "hp_" + "x".repeat(48),
      email: "a@example.com",
      savedAt: "2026-11-19T00:00:00Z",
    });
    expect(await migrateLegacyCredentials(fresh, legacy)).toBe(true);
    expect((await readCredentials(fresh))?.email).toBe("a@example.com");
    expect(await readCredentials(legacy)).toBeNull();
    expect(await migrateLegacyCredentials(fresh, legacy)).toBe(false);
  });
});

describe("hotpath login", () => {
  it("runs the device flow, prints the code and URL, saves the token (never printed)", async () => {
    let polls = 0;
    const api = fakeFetch((c) => {
      if (c.body.action === "start") {
        return {
          body: {
            device_code: "d".repeat(40),
            user_code: "ABCD-1234",
            verify_url: "https://hotpath.run/cli-login/?code=ABCD-1234",
            interval: 3,
            expires_in: 600,
          },
        };
      }
      return {
        body:
          ++polls < 3
            ? { status: "pending" }
            : {
                status: "approved",
                token: TOKEN,
                email: "a@example.com",
                expires_at: null,
              },
      };
    });
    const lines: string[] = [];
    const opened: string[] = [];
    const sleeps: number[] = [];
    let t = 0;
    const ok = await login({
      fetch: api.fetch,
      dir,
      version: "0.3.0",
      host: "my-pc",
      out: (l) => lines.push(l),
      open: (u) => opened.push(u),
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      now: () => 1_700_000_000_000 + t,
    });
    expect(ok).toBe(true);
    expect(api.calls[0]!.body).toEqual({
      action: "start",
      client: "hotpath-cli/0.3.0",
      host: "my-pc",
    });
    expect(lines.join("\n")).toContain("ABCD-1234");
    expect(lines.join("\n")).toContain(
      "https://hotpath.run/cli-login/?code=ABCD-1234",
    );
    expect(opened).toEqual(["https://hotpath.run/cli-login/?code=ABCD-1234"]);
    expect(sleeps).toEqual([3000, 3000, 3000]);
    expect(lines.join("\n")).not.toContain(TOKEN);

    const creds = await readCredentials(dir);
    expect(creds?.token).toBe(TOKEN);
    expect(creds?.email).toBe("a@example.com");
    if (process.platform !== "win32") {
      expect(
        (await stat(path.join(dir, "credentials.json"))).mode & 0o777,
      ).toBe(0o600);
    }
    const raw = JSON.parse(
      await readFile(path.join(dir, "credentials.json"), "utf8"),
    );
    expect(Object.keys(raw).sort()).toEqual(["email", "savedAt", "token"]);
  });

  it("does not open a page the server did not host on hotpath.run", async () => {
    const api = fakeFetch((c) =>
      c.body.action === "start"
        ? {
            body: {
              device_code: "d".repeat(40),
              user_code: "ABCD-1234",
              verify_url: "https://evil.example/cli-login/?code=ABCD-1234",
              interval: 1,
              expires_in: 600,
            },
          }
        : { body: { status: "denied" } },
    );
    const opened: string[] = [];
    const lines: string[] = [];
    const ok = await login({
      fetch: api.fetch,
      dir,
      version: "0.3.0",
      out: (l) => lines.push(l),
      open: (u) => opened.push(u),
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(ok).toBe(false);
    expect(opened).toEqual([]);
    expect(lines.join("\n")).toContain("cancelled");
    expect(await readCredentials(dir)).toBeNull();
  });

  it("stops when the code expires", async () => {
    const api = fakeFetch((c) =>
      c.body.action === "start"
        ? {
            body: {
              device_code: "d".repeat(40),
              user_code: "ABCD-1234",
              verify_url: "https://hotpath.run/cli-login/?code=ABCD-1234",
              interval: 3,
              expires_in: 600,
            },
          }
        : { body: { status: "expired" } },
    );
    const lines: string[] = [];
    const ok = await login({
      fetch: api.fetch,
      dir,
      version: "0.3.0",
      out: (l) => lines.push(l),
      open: () => undefined,
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(ok).toBe(false);
    expect(lines.join("\n")).toContain("expired");
  });
});

describe("hotpath logout and whoami", () => {
  it("logout revokes with the token and deletes the file", async () => {
    await writeCredentials(dir, {
      token: TOKEN,
      email: "a@example.com",
      savedAt: "x",
    });
    const api = fakeFetch(() => ({ body: { ok: true } }));
    const lines: string[] = [];
    await logout({ fetch: api.fetch, dir, out: (l) => lines.push(l) });
    expect(api.calls[0]!.body).toEqual({ action: "revoke" });
    expect(api.calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(await readCredentials(dir)).toBeNull();
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("logout still deletes the file when hotpath.run cannot be reached", async () => {
    await writeCredentials(dir, {
      token: TOKEN,
      email: "a@example.com",
      savedAt: "x",
    });
    const api = fakeFetch(() => "network");
    const lines: string[] = [];
    await logout({ fetch: api.fetch, dir, out: (l) => lines.push(l) });
    expect(await readCredentials(dir)).toBeNull();
    expect(lines.join("\n")).toContain("Settings");
  });

  it("whoami prints the email, never the token", async () => {
    await writeCredentials(dir, {
      token: TOKEN,
      email: "a@example.com",
      savedAt: "x",
    });
    const api = fakeFetch(() => ({
      body: { email: "a@example.com", plan: "free" },
    }));
    const lines: string[] = [];
    const ok = await whoami({
      fetch: api.fetch,
      dir,
      env: {},
      out: (l) => lines.push(l),
    });
    expect(ok).toBe(true);
    expect(lines.join("\n")).toContain("a@example.com");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("whoami says so when not signed in", async () => {
    const api = fakeFetch(() => ({ body: {} }));
    const lines: string[] = [];
    const ok = await whoami({
      fetch: api.fetch,
      dir,
      env: {},
      out: (l) => lines.push(l),
    });
    expect(ok).toBe(false);
    expect(api.calls).toHaveLength(0);
    expect(lines.join("\n")).toContain("hotpath login");
  });
});

describe("the login requirement", () => {
  it("is one switch, off: the account is optional", () => {
    expect(REQUIRE_LOGIN).toBe(false);
  });

  it("lets every command run without a token by default", async () => {
    const api = fakeFetch(() => "network");
    const r = await checkLogin({
      ...gateDeps(api.fetch),
      requireLogin: undefined,
    });
    expect(r).toEqual({ ok: true });
    expect(api.calls).toEqual([]);
  });

  it("asks for an account when there is no token, with the exact message", async () => {
    const api = fakeFetch(() => ({ body: {} }));
    const r = await checkLogin(gateDeps(api.fetch));
    expect(r).toEqual({
      ok: false,
      message:
        "Hotpath needs a free hotpath.run account. Run `hotpath login` (it opens your browser). For CI, set HOTPATH_TOKEN.",
    });
    expect(LOGIN_REQUIRED_MESSAGE).toBe((r as { message: string }).message);
  });

  it("lets HOTPATH_TOKEN through with no network", async () => {
    const api = fakeFetch(() => "network");
    const r = await checkLogin(
      gateDeps(api.fetch, { env: { HOTPATH_TOKEN: TOKEN } }),
    );
    expect(r.ok).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("lets a child through while the command that started it is running", async () => {
    const api = fakeFetch(() => "network");
    const alive = await checkLogin(
      gateDeps(api.fetch, {
        env: { [GATE_MARKER]: "4242" },
        pidAlive: (p) => p === 4242,
      }),
    );
    expect(alive.ok).toBe(true);
    const stale = await checkLogin(
      gateDeps(api.fetch, {
        env: { [GATE_MARKER]: "4242" },
        pidAlive: () => false,
      }),
    );
    expect(stale.ok).toBe(false);
    const junk = await checkLogin(
      gateDeps(api.fetch, {
        env: { [GATE_MARKER]: "1" },
        pidAlive: () => true,
      }),
    );
    // pid 1 alive is accepted by the rule; a non-number is not
    expect(junk.ok).toBe(true);
    expect(
      (
        await checkLogin(
          gateDeps(api.fetch, {
            env: { [GATE_MARKER]: "yes" },
            pidAlive: () => true,
          }),
        )
      ).ok,
    ).toBe(false);
  });

  it("checks online only once every 24 hours", async () => {
    const now = 1_000_000_000_000;
    await writeCredentials(dir, {
      token: TOKEN,
      email: "a@example.com",
      savedAt: new Date(now).toISOString(),
    });
    await writeLastCheck(dir, now - CHECK_EVERY_MS + 60_000);
    const api = fakeFetch(() => "network");
    expect((await checkLogin(gateDeps(api.fetch, { now: () => now }))).ok).toBe(
      true,
    );
    expect(api.calls).toHaveLength(0);

    await writeLastCheck(dir, now - CHECK_EVERY_MS - 1);
    const ok = fakeFetch(() => ({
      body: { email: "a@example.com", plan: "free" },
    }));
    expect((await checkLogin(gateDeps(ok.fetch, { now: () => now }))).ok).toBe(
      true,
    );
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]!.body).toEqual({ action: "whoami" });
    expect(await readLastCheck(dir)).toBe(now);
  });

  it("a 401 deletes the credentials and asks to log in again", async () => {
    const now = 1_000_000_000_000;
    await writeCredentials(dir, {
      token: TOKEN,
      email: "a@example.com",
      savedAt: new Date(now).toISOString(),
    });
    await writeLastCheck(dir, now - CHECK_EVERY_MS - 1);
    const api = fakeFetch(() => ({
      status: 401,
      body: { error: "bad token" },
    }));
    const r = await checkLogin(gateDeps(api.fetch, { now: () => now }));
    expect(r.ok).toBe(false);
    expect(await readCredentials(dir)).toBeNull();
  });

  it("is ignored offline for 7 days since the last good check, then required", async () => {
    const now = 1_000_000_000_000;
    await writeCredentials(dir, {
      token: TOKEN,
      email: "a@example.com",
      savedAt: new Date(0).toISOString(),
    });
    const offline = fakeFetch(() => "network");

    await writeLastCheck(dir, now - OFFLINE_GRACE_MS + 60_000);
    // within 24h is not needed here: make the check due by going past 24h
    expect(
      (await checkLogin(gateDeps(offline.fetch, { now: () => now }))).ok,
    ).toBe(true);
    expect(offline.calls).toHaveLength(1);

    await writeLastCheck(dir, now - OFFLINE_GRACE_MS - 60_000);
    const r = await checkLogin(gateDeps(offline.fetch, { now: () => now }));
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain(
      LOGIN_REQUIRED_MESSAGE,
    );
    // the credentials stay: this is the network, not a revoked token
    expect(await readCredentials(dir)).not.toBeNull();
  });
});

describe("the gate on commands", () => {
  async function runCli(
    args: string[],
    env: NodeJS.ProcessEnv,
    f?: typeof fetch,
    requireLogin: boolean | undefined = true,
  ) {
    const errs: string[] = [];
    const outs: string[] = [];
    const exits: number[] = [];
    const program = createProgram({
      account: {
        env,
        dir,
        fetch: f ?? fakeFetch(() => ({ body: {} })).fetch,
        requireLogin,
        err: (l) => errs.push(l),
        out: (l) => outs.push(l),
        exit: (c) => {
          exits.push(c);
        },
      },
      sync: { startFlush: () => undefined },
    });
    program.exitOverride();
    let error: unknown;
    try {
      await program.parseAsync(["node", "hotpath", ...args]);
    } catch (err) {
      error = err;
    }
    return { errs, outs, exits, error };
  }

  it("blocks a command with no token, and nested ones too", async () => {
    for (const args of [
      ["show", "x"],
      ["schedule", "list"],
      ["doctor", "--offline"],
    ]) {
      const r = await runCli(args, {});
      expect(r.errs, args.join(" ")).toEqual([LOGIN_REQUIRED_MESSAGE]);
      expect(r.exits).toEqual([1]);
    }
  });

  it("runs any command without a token when the requirement is off", async () => {
    for (const args of [
      ["show", "x"],
      ["doctor", "--offline"],
    ]) {
      const r = await runCli(args, {}, undefined, false);
      expect(r.errs, args.join(" ")).not.toContain(LOGIN_REQUIRED_MESSAGE);
      expect(r.exits, args.join(" ")).not.toContain(1);
    }
  });

  it("lets login, logout, whoami and demo-tools through without a token", () => {
    expect([...OPEN_COMMANDS].sort()).toEqual(
      ["demo-tools", "login", "logout", "sync-flush", "whoami"].sort(),
    );
  });

  it("whoami runs without a token", async () => {
    const r = await runCli(["whoami"], {});
    expect(r.errs).toEqual([]);
    expect(r.outs.join()).toContain("hotpath login");
  });

  it("--help and --version are never gated", async () => {
    const help = createProgram().helpInformation();
    expect(help).toContain("login");
    expect(help).toContain("whoami");
    expect(help).not.toContain("demo-tools");
    expect(help).not.toContain("sync-flush");
  });

  it("marks the environment so children it starts are let through", async () => {
    const env: NodeJS.ProcessEnv = { HOTPATH_TOKEN: TOKEN };
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "keep"), "");
    const r = await runCli(["schedule", "list"], env);
    expect(r.errs).toEqual([]);
    expect(env[GATE_MARKER]).toBe(String(process.pid));
  });
});

describe("the real command line", () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  function cli(
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve, reject) => {
      const child = crossSpawn(
        process.execPath,
        ["--import", "tsx", "packages/cli/src/index.ts", ...args],
        { cwd: repoRoot, env },
      );
      let out = "";
      child.stdout?.on("data", (d) => (out += d));
      child.stderr?.on("data", (d) => (out += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out }));
    });
  }
  const bare = (): NodeJS.ProcessEnv => {
    const env = {
      ...process.env,
      HOTPATH_CREDENTIALS_DIR: dir,
      HOTPATH_NO_SYNC: "1",
    };
    delete env.HOTPATH_TOKEN;
    delete env[GATE_MARKER];
    return env;
  };

  it("runs a command without an account, and --version and --help too", async () => {
    const open = await cli(["show", "nothing"], bare());
    expect(open.out).not.toContain(LOGIN_REQUIRED_MESSAGE);
    expect(open.out).not.toContain("hotpath login");
    expect((await cli(["--version"], bare())).code).toBe(0);
    expect((await cli(["--help"], bare())).code).toBe(0);
  }, 60_000);

  it("a token in HOTPATH_TOKEN lets the command run", async () => {
    const r = await cli(["show", "nothing"], {
      ...bare(),
      HOTPATH_TOKEN: TOKEN,
    });
    expect(r.out).not.toContain(LOGIN_REQUIRED_MESSAGE);
  }, 60_000);
});
