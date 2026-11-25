import { HttpError, post, type Fetch } from "./api.js";
import {
  CHECK_EVERY_MS,
  LOGIN_REQUIRED_MESSAGE,
  OFFLINE_GRACE_MS,
  REQUIRE_LOGIN,
} from "./config.js";
import {
  deleteCredentials,
  readCredentials,
  readLastCheck,
  writeLastCheck,
} from "./credentials.js";

/**
 * Commands that never need an account. `demo-tools` is the internal MCP tool
 * server: an MCP client starts it with no terminal and it only serves fake data.
 */
export const OPEN_COMMANDS = new Set([
  "login",
  "logout",
  "whoami",
  "demo-tools",
  // hidden: sends the queued summaries, started detached after a gated command
  "sync-flush",
]);

/**
 * Set (to the pid of the command that passed the gate) in the environment of
 * every gated command. A child it starts (the recorder, a scheduled run, the
 * demo's agent) sees it and is let through: its parent already checked, and a
 * child has no terminal to explain a failure. Only honoured while that pid is
 * still running, so a stale value in a shell profile unlocks nothing.
 */
export const GATE_MARKER = "HOTPATH_GATE_PASSED";

export interface GateDeps {
  env: NodeJS.ProcessEnv;
  dir: string;
  fetch: Fetch;
  now: () => number;
  pidAlive: (pid: number) => boolean;
  /** how long the online check may take before it counts as "offline" */
  timeoutMs?: number;
  /** whether a command needs an account; REQUIRE_LOGIN unless set */
  requireLogin?: boolean;
}

export type GateResult = { ok: true } | { ok: false; message: string };

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The token in use: HOTPATH_TOKEN (CI) first, else the credentials file. */
export async function currentToken(
  env: NodeJS.ProcessEnv,
  dir: string,
): Promise<string | null> {
  const fromEnv = env.HOTPATH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return (await readCredentials(dir))?.token ?? null;
}

export async function checkLogin(deps: GateDeps): Promise<GateResult> {
  if (!(deps.requireLogin ?? REQUIRE_LOGIN)) return { ok: true };
  const marker = Number(deps.env[GATE_MARKER]);
  if (Number.isInteger(marker) && marker > 0 && deps.pidAlive(marker)) {
    return { ok: true };
  }
  // CI: the token is trusted as given (no network needed, nothing cached);
  // sync sends it, and the server rejects a bad one there.
  if (deps.env.HOTPATH_TOKEN?.trim()) return { ok: true };

  const creds = await readCredentials(deps.dir);
  if (!creds) return { ok: false, message: LOGIN_REQUIRED_MESSAGE };

  const now = deps.now();
  const lastGood = await readLastCheck(deps.dir);
  if (lastGood !== null && now - lastGood < CHECK_EVERY_MS) return { ok: true };

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 4000);
    try {
      await post(
        deps.fetch,
        "cli-auth",
        { action: "whoami" },
        creds.token,
        ctl.signal,
      );
    } finally {
      clearTimeout(timer);
    }
    await writeLastCheck(deps.dir, now);
    return { ok: true };
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      await deleteCredentials(deps.dir);
      return { ok: false, message: LOGIN_REQUIRED_MESSAGE };
    }
    // offline, or the server is down: carry on for up to 7 days since the last good check
    const since = lastGood ?? (Date.parse(creds.savedAt) || 0);
    if (now - since <= OFFLINE_GRACE_MS) return { ok: true };
    return {
      ok: false,
      message: `${LOGIN_REQUIRED_MESSAGE} (Hotpath could not reach hotpath.run to confirm your account for over 7 days.)`,
    };
  }
}
