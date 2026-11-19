import { chmod, readFile, writeFile } from "node:fs/promises";

import { parseEnv, setEnv } from "./env-file.js";
import { findPreset, PRESETS, type Preset } from "./presets.js";

/** Asks one question; `secret` answers must not be echoed. */
export type Ask = (
  question: string,
  opts?: { secret?: boolean },
) => Promise<string>;

export interface InitOptions {
  /** the .env file to create or update */
  envFile: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  agentModel?: string;
  cheapModel?: string;
  /** accept the defaults instead of asking */
  yes?: boolean;
  ask?: Ask;
  log?: (line: string) => void;
}

export interface InitResult {
  envFile: string;
  created: boolean;
  provider: string;
  /** the keys written (values of secrets are never returned) */
  keys: string[];
}

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

async function readOrEmpty(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Writes the model settings to .env, asking for what the flags left out.
 * Without `ask` (not a terminal) every missing value must have a default.
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const log = options.log ?? console.log;
  const existingText = await readOrEmpty(options.envFile);
  const existing = existingText ? parseEnv(existingText) : {};
  const ask = options.yes ? undefined : options.ask;

  const choose = async (question: string, fallback: string, secret = false) => {
    if (!ask) return fallback;
    const shown =
      fallback && !secret
        ? ` [${fallback}]`
        : secret && fallback
          ? " [keep current]"
          : "";
    const answer = (await ask(`${question}${shown}: `, { secret })).trim();
    return answer || fallback;
  };

  // 1. provider
  let preset: Preset | undefined = options.provider
    ? findPreset(options.provider)
    : undefined;
  if (options.provider && !preset) {
    throw new InitError(
      `unknown provider "${options.provider}" — use one of: ${PRESETS.map((p) => p.id).join(", ")}`,
    );
  }
  if (!preset) {
    if (ask) {
      log("Where should the AI steps run?");
      PRESETS.forEach((p, i) => log(`  ${i + 1}. ${p.label}`));
      const pick = await choose("Pick a number", "1");
      preset = PRESETS[Number(pick) - 1] ?? findPreset(pick);
      if (!preset)
        throw new InitError(
          `"${pick}" is not one of the choices; run hotpath init again`,
        );
    } else {
      preset = PRESETS[0]!;
    }
  }

  // 2. URL, key, models (flags win, then what .env has for this provider, then the preset)
  const sameProvider = existing.LLM_BASE_URL === preset.baseUrl;
  const baseUrl =
    options.baseUrl ??
    (await choose(
      "Endpoint URL (OpenAI-compatible)",
      preset.baseUrl || existing.LLM_BASE_URL || "",
    ));
  if (!baseUrl)
    throw new InitError("an endpoint URL is needed: pass --base-url <url>");

  let apiKey = options.apiKey ?? preset.apiKey;
  if (apiKey === undefined) {
    const current = sameProvider ? existing.LLM_API_KEY : undefined;
    if (preset.keyHint && ask)
      log(
        `API key: get one at ${preset.keyHint}. It is stored only in ${options.envFile}.`,
      );
    apiKey = await choose("API key", current ?? "", true);
    if (!apiKey)
      throw new InitError(
        "an API key is needed for this provider: pass --api-key, or run hotpath init in a terminal",
      );
  }

  const agentModel =
    options.agentModel ??
    (await choose(
      "Agent model (records tasks; the strong one)",
      preset.agentModel || existing.HOTPATH_AGENT_MODEL || "",
    ));
  const cheapModel =
    options.cheapModel ??
    (await choose(
      "Replay model (the short AI steps; a fast one)",
      preset.cheapModel || existing.HOTPATH_CHEAP_MODEL || "",
    ));
  if (!agentModel || !cheapModel) {
    throw new InitError(
      "both model names are needed: pass --agent-model and --cheap-model",
    );
  }

  const values: Record<string, string> = {
    LLM_BASE_URL: baseUrl,
    LLM_API_KEY: apiKey,
    HOTPATH_AGENT_MODEL: agentModel,
    HOTPATH_CHEAP_MODEL: cheapModel,
    ...(preset.extra ?? {}),
  };
  await writeFile(options.envFile, setEnv(existingText ?? "", values), {
    mode: 0o600,
  });
  // an existing file keeps its old mode on write: the key must not stay
  // readable by other users of the machine (no effect on Windows)
  await chmod(options.envFile, 0o600).catch(() => undefined);

  log("");
  log(
    `${existingText === null ? "Created" : "Updated"} ${options.envFile} (${preset.id}: ${baseUrl}).`,
  );
  log(
    "The key stays in that file; Hotpath never prints or sends it anywhere else.",
  );
  if (preset.id !== "ollama") {
    log(
      "Check the model names match your provider's exact ids: hotpath doctor lists what it finds.",
    );
  } else {
    log(`If you haven't yet: ollama pull ${cheapModel}`);
  }
  log("");
  log("Next:");
  log("  hotpath doctor                         check everything works");
  log(
    "  hotpath demo                           try it end to end on the demo agent",
  );
  log(
    "  hotpath wrap claude-code <server> --task <name>   record a task from your agent",
  );
  return {
    envFile: options.envFile,
    created: existingText === null,
    provider: preset.id,
    keys: Object.keys(values),
  };
}
