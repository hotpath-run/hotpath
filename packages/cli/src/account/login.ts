import os from "node:os";

import crossSpawn from "cross-spawn";

import { HttpError, post, type Fetch } from "./api.js";
import {
  deleteCredentials,
  readCredentials,
  writeCredentials,
  writeLastCheck,
} from "./credentials.js";

export interface LoginDeps {
  fetch: Fetch;
  dir: string;
  version: string;
  out: (line: string) => void;
  open: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  host?: string;
}

/** Opens a URL with the platform's opener; an argument array, never a shell string. */
export function openInBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = crossSpawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined); // no opener: the URL is printed anyway
    child.unref();
  } catch {
    // same
  }
}

/** Only ever open the page we expect: the URL comes from the server's answer. */
function safeToOpen(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)hotpath\.run$/.test(u.hostname);
  } catch {
    return false;
  }
}

export async function login(deps: LoginDeps): Promise<boolean> {
  const start = await post(deps.fetch, "cli-auth", {
    action: "start",
    client: `hotpath-cli/${deps.version}`,
    host: deps.host ?? os.hostname(),
  });
  const device = String(start.device_code ?? "");
  const userCode = String(start.user_code ?? "");
  const url = String(start.verify_url ?? "");
  if (!device || !userCode || !url) {
    throw new Error(
      "hotpath.run answered with something unexpected. Try again in a minute.",
    );
  }
  const interval = Math.max(1, Number(start.interval) || 3) * 1000;
  const deadline = deps.now() + (Number(start.expires_in) || 600) * 1000;

  deps.out(`Your code: ${userCode}`);
  deps.out(`Open this page to sign in and approve it: ${url}`);
  if (safeToOpen(url)) deps.open(url);
  deps.out("Waiting for you to approve in the browser…");

  while (deps.now() < deadline) {
    await deps.sleep(interval);
    const res = await post(deps.fetch, "cli-auth", {
      action: "poll",
      device_code: device,
    });
    switch (res.status) {
      case "approved": {
        const token = String(res.token ?? "");
        if (!token) {
          throw new Error(
            "hotpath.run approved the login but sent no token. Try again.",
          );
        }
        const email = String(res.email ?? "");
        const now = deps.now();
        await writeCredentials(deps.dir, {
          token,
          email,
          savedAt: new Date(now).toISOString(),
        });
        await writeLastCheck(deps.dir, now);
        deps.out(`Signed in as ${email}.`);
        return true;
      }
      case "denied":
        deps.out(
          "The login was cancelled on hotpath.run. Run `hotpath login` to try again.",
        );
        return false;
      case "expired":
        deps.out("The code expired. Run `hotpath login` to get a new one.");
        return false;
      default:
        break; // pending
    }
  }
  deps.out("The code expired. Run `hotpath login` to get a new one.");
  return false;
}

export async function logout(
  deps: Pick<LoginDeps, "fetch" | "dir" | "out">,
): Promise<void> {
  const creds = await readCredentials(deps.dir);
  if (!creds) {
    deps.out("You are not signed in.");
    return;
  }
  try {
    await post(deps.fetch, "cli-auth", { action: "revoke" }, creds.token);
  } catch (err) {
    // the file still goes: the token can be revoked on the dashboard (Settings → CLI sessions)
    if (!(err instanceof HttpError && err.status === 401)) {
      deps.out(
        "Could not reach hotpath.run to revoke this session; revoke it under Settings → CLI sessions on the dashboard.",
      );
    }
  }
  await deleteCredentials(deps.dir);
  deps.out("Signed out.");
}

/** Prints the signed-in email; false when not signed in (or the token no longer works). */
export async function whoami(
  deps: Pick<LoginDeps, "fetch" | "dir" | "out"> & { env: NodeJS.ProcessEnv },
): Promise<boolean> {
  const token =
    deps.env.HOTPATH_TOKEN?.trim() || (await readCredentials(deps.dir))?.token;
  if (!token) {
    deps.out("Not signed in. Run `hotpath login`.");
    return false;
  }
  try {
    const res = await post(deps.fetch, "cli-auth", { action: "whoami" }, token);
    deps.out(`${String(res.email ?? "")} (${String(res.plan ?? "free")})`);
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      deps.out("That session is no longer valid. Run `hotpath login`.");
      return false;
    }
    // offline: the saved email still says who it is
    const saved = await readCredentials(deps.dir);
    if (saved?.email) {
      deps.out(`${saved.email} (offline, not checked)`);
      return true;
    }
    deps.out("Could not reach hotpath.run.");
    return false;
  }
}
