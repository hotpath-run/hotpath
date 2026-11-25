import type { Command } from "commander";

import type { Fetch } from "./api.js";
import {
  credentialsDir,
  legacyCredentialsDir,
  migrateLegacyCredentials,
} from "./credentials.js";
import { GATE_MARKER, OPEN_COMMANDS, checkLogin, pidAlive } from "./gate.js";
import { login, logout, openInBrowser, whoami } from "./login.js";

export interface AccountDeps {
  fetch: Fetch;
  env: NodeJS.ProcessEnv;
  dir: string;
  version: string;
  now: () => number;
  exit: (code: number) => never | void;
  out: (line: string) => void;
  err: (line: string) => void;
  /** an old sign-in folder to move from (~/.hotpath); unset: nothing to move */
  legacyDir?: string;
  /** whether commands need an account; REQUIRE_LOGIN unless set */
  requireLogin?: boolean;
}

export function defaultAccountDeps(version: string): AccountDeps {
  return {
    fetch: globalThis.fetch,
    env: process.env,
    dir: credentialsDir(process.env),
    legacyDir: process.env.HOTPATH_CREDENTIALS_DIR?.trim()
      ? undefined
      : legacyCredentialsDir(),
    version,
    now: Date.now,
    exit: (code) => process.exit(code),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

/** Moves a sign-in from ~/.hotpath once; never fails the command. */
async function moveOldSignIn(deps: AccountDeps): Promise<void> {
  if (!deps.legacyDir) return;
  await migrateLegacyCredentials(deps.dir, deps.legacyDir).catch(() => false);
}

function topLevelName(command: Command): string {
  let c = command;
  while (c.parent?.parent) c = c.parent;
  return c.name();
}

/**
 * The login requirement, when it is on: every command except login, logout,
 * whoami and the internal ones (--help and --version never reach an action)
 * needs a token. Off by default (REQUIRE_LOGIN).
 */
export function addLoginGate(program: Command, deps: AccountDeps): void {
  program.hook("preAction", async (_program, action) => {
    await moveOldSignIn(deps);
    if (OPEN_COMMANDS.has(topLevelName(action))) return;
    const result = await checkLogin({
      env: deps.env,
      dir: deps.dir,
      fetch: deps.fetch,
      now: deps.now,
      pidAlive,
      requireLogin: deps.requireLogin,
    });
    if (!result.ok) {
      deps.err(result.message);
      deps.exit(1);
      // an injected exit that returns: still do not run the command
      throw new Error(result.message);
    }
    // children (the recorder, the demo's agent, scheduled runs) inherit this
    deps.env[GATE_MARKER] = String(process.pid);
  });
}

export function addAccountCommands(program: Command, deps: AccountDeps): void {
  const loginDeps = () => ({
    fetch: deps.fetch,
    dir: deps.dir,
    version: deps.version,
    out: deps.out,
    open: openInBrowser,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now: deps.now,
  });
  const failed = (err: unknown) => {
    deps.err(err instanceof Error ? err.message : String(err));
    deps.exit(1);
  };

  program
    .command("login")
    .description(
      "Sign in to your free hotpath.run account (opens your browser)",
    )
    .action(async () => {
      try {
        if (!(await login(loginDeps()))) deps.exit(1);
      } catch (err) {
        failed(err);
      }
    });

  program
    .command("logout")
    .description("Sign out and revoke this computer's session")
    .action(async () => {
      try {
        await logout(loginDeps());
      } catch (err) {
        failed(err);
      }
    });

  program
    .command("whoami")
    .description("Show the account you are signed in as")
    .action(async () => {
      try {
        if (!(await whoami({ ...loginDeps(), env: deps.env }))) deps.exit(1);
      } catch (err) {
        failed(err);
      }
    });
}
