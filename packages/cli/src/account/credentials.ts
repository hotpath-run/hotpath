import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Credentials {
  token: string;
  email: string;
  savedAt: string;
}

/**
 * The user's settings folder: %APPDATA%\hotpath on Windows, else
 * $XDG_CONFIG_HOME/hotpath or ~/.config/hotpath. Never a folder named .hotpath:
 * that name marks a project, and a ~/.hotpath made every folder under home one.
 * HOTPATH_CREDENTIALS_DIR overrides it (tests).
 */
export function credentialsDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const override = env.HOTPATH_CREDENTIALS_DIR?.trim();
  if (override) return override;
  if (platform === "win32") {
    return path.join(
      env.APPDATA?.trim() || path.join(home, "AppData", "Roaming"),
      "hotpath",
    );
  }
  return path.join(
    env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"),
    "hotpath",
  );
}

/** Where a pre-release 0.3.0 kept the sign-in. */
export function legacyCredentialsDir(home: string = os.homedir()): string {
  return path.join(home, ".hotpath");
}

/**
 * Moves a sign-in from the old ~/.hotpath to `dir` when `dir` has none.
 * Returns true when it moved one.
 */
export async function migrateLegacyCredentials(
  dir: string,
  legacyDir: string = legacyCredentialsDir(),
): Promise<boolean> {
  if (path.resolve(dir) === path.resolve(legacyDir)) return false;
  if (await readCredentials(dir)) return false;
  const old = await readCredentials(legacyDir);
  if (!old) return false;
  await writeCredentials(dir, old);
  await deleteCredentials(legacyDir);
  return true;
}

const file = (dir: string) => path.join(dir, "credentials.json");
const checkFile = (dir: string) => path.join(dir, "last-check.json");

export async function readCredentials(
  dir: string,
): Promise<Credentials | null> {
  try {
    const c = JSON.parse(
      await readFile(file(dir), "utf8"),
    ) as Partial<Credentials>;
    return typeof c.token === "string" && c.token.length > 0
      ? { token: c.token, email: c.email ?? "", savedAt: c.savedAt ?? "" }
      : null;
  } catch {
    return null;
  }
}

export async function writeCredentials(
  dir: string,
  c: Credentials,
): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file(dir), JSON.stringify(c, null, 2) + "\n", {
    mode: 0o600,
  });
  // writeFile's mode only applies to a new file
  await chmod(file(dir), 0o600).catch(() => undefined);
}

export async function deleteCredentials(dir: string): Promise<void> {
  await rm(file(dir), { force: true });
  await rm(checkFile(dir), { force: true });
}

/** When the token last passed an online check (ms since epoch), or null. */
export async function readLastCheck(dir: string): Promise<number | null> {
  try {
    const v = JSON.parse(await readFile(checkFile(dir), "utf8")) as {
      at?: number;
    };
    return typeof v.at === "number" ? v.at : null;
  } catch {
    return null;
  }
}

export async function writeLastCheck(dir: string, at: number): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(checkFile(dir), JSON.stringify({ at }) + "\n", {
    mode: 0o600,
  });
}
