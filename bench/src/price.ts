import { readFile } from "node:fs/promises";

import { priceTokenLog, type PricePair, type TokenLine } from "./pricing.js";

// `pnpm bench:price [--per-day N] <bench-tokens.jsonl>…`: what the recorded
// runs would cost on paid APIs. Prices per 1M tokens (input / output), USD.
// Re-check them before quoting: providers change prices often.
export const PAIRS: PricePair[] = [
  {
    label: "Claude Opus 5.5 → Haiku 5.5",
    agent: { model: "claude-opus-5-5", inPer1M: 4, outPer1M: 20 },
    replay: { model: "claude-haiku-5-5", inPer1M: 0.1, outPer1M: 0.5 },
    source: "Anthropic price table, 2026-11-03",
  },
  {
    label: "Claude Sonnet 5.5 → Haiku 5.5",
    agent: { model: "claude-sonnet-5-5", inPer1M: 2, outPer1M: 10 },
    replay: { model: "claude-haiku-5-5", inPer1M: 0.1, outPer1M: 0.5 },
    source: "Anthropic price table, 2026-11-03",
  },
  {
    label: "Claude Sonnet 5.5 → Sonnet 5.5 (same model)",
    agent: { model: "claude-sonnet-5-5", inPer1M: 2, outPer1M: 10 },
    replay: { model: "claude-sonnet-5-5", inPer1M: 2, outPer1M: 10 },
    source: "Anthropic price table, 2026-11-03",
  },
  {
    label: "DeepSeek V4 Pro → V4.1 Flash (peak)",
    agent: { model: "deepseek-v4-pro", inPer1M: 1.32, outPer1M: 3.96 },
    replay: { model: "deepseek-flash", inPer1M: 0.3, outPer1M: 1.2 },
    source: "third-party price trackers, 2026-11 (not the official page)",
  },
  {
    label: "OpenAI GPT-6 Astra → GPT-6 Luna",
    agent: { model: "gpt-6-astra", inPer1M: 10, outPer1M: 50 },
    replay: { model: "gpt-6-luna", inPer1M: 0.1, outPer1M: 0.5 },
    source: "third-party price trackers, 2026-11 (not the official page)",
  },
];

const money = (usd: number) =>
  usd >= 100
    ? `$${Math.round(usd).toLocaleString("en")}`
    : usd >= 1
      ? `$${usd.toFixed(2)}`
      : `$${usd.toFixed(5)}`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const perDayAt = argv.indexOf("--per-day");
  const perDay = perDayAt >= 0 ? Number(argv[perDayAt + 1]) : 1000;
  const files = argv.filter(
    (_, i) => perDayAt < 0 || (i !== perDayAt && i !== perDayAt + 1),
  );
  if (files.length === 0) {
    throw new Error(
      "usage: pnpm bench:price [--per-day N] <out/bench-tokens.jsonl>…",
    );
  }
  const lines: TokenLine[] = [];
  for (const file of files) {
    for (const raw of (await readFile(file, "utf8")).split("\n")) {
      if (raw.trim()) lines.push(JSON.parse(raw) as TokenLine);
    }
  }
  const rows = priceTokenLog(lines, PAIRS, perDay);
  if (rows.length === 0) {
    console.log("no passing run with an agent comparison to price");
    return;
  }
  console.log(
    `${rows[0].runs} passing run(s); month = ${perDay.toLocaleString("en")} runs/day × 30\n`,
  );
  console.log(
    [
      "pair",
      "agent/run",
      "replay/run",
      "cheaper",
      "agent/month",
      "hotpath/month",
    ].join(" | "),
  );
  for (const r of rows) {
    console.log(
      [
        r.label,
        money(r.agentUsdPerRun),
        money(r.replayUsdPerRun),
        `${r.cheaper.toFixed(0)}×`,
        money(r.agentUsdPerMonth),
        money(r.replayUsdPerMonth),
      ].join(" | "),
    );
  }
  console.log(
    "\nPrices: " + [...new Set(PAIRS.map((p) => p.source))].join("; "),
  );
}

await main();
