// Model providers `hotpath init` knows. Any OpenAI-compatible endpoint works
// ("custom"); the presets only fill in the URL and sensible model names.

export interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  /** Ollama ignores the key, but the client needs one */
  apiKey?: string;
  agentModel: string;
  cheapModel: string;
  /** where to get a key, shown when one is needed */
  keyHint?: string;
  /** extra settings that measured best for this provider */
  extra?: Record<string, string>;
}

export const PRESETS: Preset[] = [
  {
    id: "ollama",
    label: "Ollama on this computer (free, nothing leaves the machine)",
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama",
    agentModel: "qwen3:1.7b",
    cheapModel: "qwen3:1.7b",
    // measured on qwen3:1.7b (docs/BENCHMARK.md, "Local open models")
    extra: {
      HOTPATH_REPAIR_MENTIONS: "1",
      PRICE_AGENT_IN: "0",
      PRICE_AGENT_OUT: "0",
      PRICE_CHEAP_IN: "0",
      PRICE_CHEAP_OUT: "0",
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    agentModel: "gpt-6-astra",
    cheapModel: "gpt-6-luna",
    keyHint: "platform.openai.com → API keys",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    agentModel: "openai/gpt-oss-120b",
    cheapModel: "openai/gpt-oss-20b",
    keyHint: "console.groq.com → API Keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter (many models behind one key)",
    baseUrl: "https://openrouter.ai/api/v1",
    agentModel: "anthropic/claude-sonnet-5.5",
    cheapModel: "anthropic/claude-haiku-5.5",
    keyHint: "openrouter.ai → Keys",
  },
  {
    id: "custom",
    label: "Another OpenAI-compatible endpoint",
    baseUrl: "",
    agentModel: "",
    cheapModel: "",
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id.toLowerCase());
}
