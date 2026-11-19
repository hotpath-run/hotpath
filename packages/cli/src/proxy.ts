import { InvalidArgumentError, type Command } from "commander";

import {
  DEFAULT_ANTHROPIC_UPSTREAM,
  DEFAULT_OPENAI_UPSTREAM,
  DEFAULT_PORT,
  startProxy,
  type ProxyOptions,
} from "@hotpathrun/proxy";

interface ProxyFlags {
  port: string;
  host: string;
  openai: string;
  anthropic: string;
  recordOnly?: boolean;
  readOnly?: string;
}

function port(value: string): string {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new InvalidArgumentError("a port is a whole number from 0 to 65535");
  }
  return value;
}

/** The options `hotpath proxy` starts the proxy with (pure, for tests). */
export function proxyOptions(flags: ProxyFlags): ProxyOptions {
  return {
    port: Number(flags.port),
    host: flags.host,
    openaiUpstream: flags.openai,
    anthropicUpstream: flags.anthropic,
    mode: flags.recordOnly ? "record" : "auto",
    readOnly: (flags.readOnly ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** What to tell the user once it listens: the one line their agent changes. */
export function proxyBanner(url: string, options: ProxyOptions): string {
  return [
    `Hotpath proxy on ${url} (${options.mode === "record" ? "recording only" : "records, and answers from compiled workflows"})`,
    `  OpenAI SDK:    baseURL: "${url}/v1"     → ${options.openaiUpstream}`,
    `  Anthropic SDK: baseURL: "${url}"        → ${options.anthropicUpstream}`,
    "  Your key goes through on each request; Hotpath never stores it.",
    "  Ctrl+C stops it; conversations still open are written as traces.",
  ].join("\n");
}

export function registerProxy(program: Command): void {
  program
    .command("proxy")
    .description(
      "Start the model proxy: point your agent's model base URL at it, change nothing else",
    )
    .option("--port <port>", "port to listen on", port, String(DEFAULT_PORT))
    .option(
      "--host <host>",
      "127.0.0.1, localhost or ::1 (the proxy sees every key: never the network)",
      "127.0.0.1",
    )
    .option(
      "--openai <url>",
      "where Chat Completions requests go (e.g. http://localhost:11434/v1 for Ollama)",
      process.env.HOTPATH_PROXY_OPENAI ?? DEFAULT_OPENAI_UPSTREAM,
    )
    .option(
      "--anthropic <url>",
      "where Messages requests go",
      process.env.HOTPATH_PROXY_ANTHROPIC ?? DEFAULT_ANTHROPIC_UPSTREAM,
    )
    .option(
      "--read-only <tools>",
      "comma-separated tools that only read (the others are treated as actions)",
    )
    .option(
      "--record-only",
      "record conversations, never answer from a workflow",
    )
    .action(async (flags: ProxyFlags) => {
      try {
        const options = proxyOptions(flags);
        const proxy = await startProxy(options);
        console.log(proxyBanner(proxy.url, options));
        const stop = () => {
          void proxy.close().then(() => process.exit(0));
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
