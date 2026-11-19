import { runAgent } from "./agent.js";

// pnpm --filter proxy-agent start -- --date 2026-10-01
//   runs the agent once. With `hotpath proxy --openai http://localhost:11434/v1
//   --read-only get_orders` running, its default base URL goes through Hotpath.

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};

async function main(): Promise<void> {
  const result = await runAgent({
    // the one line that puts Hotpath in front of the model
    baseURL: flag("--base-url", "http://127.0.0.1:8787/v1"),
    model: flag("--model", "qwen3.5:4b"),
    date: flag("--date", "2026-10-01"),
    // Ollama takes any key; a real provider's key comes from the environment
    apiKey: process.env.OPENAI_API_KEY ?? "ollama",
  });
  console.log(
    `${result.requests} chat request(s), ${(result.ms / 1000).toFixed(1)}s, tools: ` +
      (result.toolCalls.map((c) => c.name).join(", ") || "(none)"),
  );
  console.log(`answer: ${result.answer}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
