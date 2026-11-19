// Prices the token counts recorded by `pnpm bench` (out/bench-tokens.jsonl) at
// any provider's rates. Runs on local models cost $0, but the number of tokens
// an agent run and a workflow replay use is what carries over to paid APIs:
// the agent re-reads its whole conversation on every turn with the expensive
// model; the replay makes one short call with a cheap one.

export interface TokenCounts {
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
}

/** One line of out/bench-tokens.jsonl. */
export interface TokenLine {
  scenario: string;
  pass: boolean;
  fallback: boolean;
  agentModel?: string;
  cheapModel?: string;
  agent: TokenCounts | null;
  hotpath: TokenCounts;
}

export interface ModelPrice {
  model: string;
  inPer1M: number;
  outPer1M: number;
}

/** The model the agent uses, and the cheap model the workflow replays with. */
export interface PricePair {
  label: string;
  agent: ModelPrice;
  replay: ModelPrice;
  /** where the prices come from and when they were read */
  source?: string;
}

export interface PricedRow {
  label: string;
  runs: number;
  agentUsdPerRun: number;
  replayUsdPerRun: number;
  cheaper: number;
  runsPerDay: number;
  agentUsdPerMonth: number;
  replayUsdPerMonth: number;
}

const usd = (t: TokenCounts, p: ModelPrice) =>
  (t.promptTokens * p.inPer1M + t.completionTokens * p.outPer1M) / 1_000_000;

/**
 * Average cost per run for each pair, over the runs that passed and have a
 * comparison agent run (a failed run is not a fair price), plus a 30-day
 * projection at `runsPerDay`. Pairs with no qualifying run are left out.
 */
export function priceTokenLog(
  lines: TokenLine[],
  pairs: PricePair[],
  runsPerDay = 100,
): PricedRow[] {
  const usable = lines.filter(
    (l): l is TokenLine & { agent: TokenCounts } =>
      l.pass && !l.fallback && l.agent !== null,
  );
  if (usable.length === 0) return [];
  return pairs.map((pair) => {
    const agent =
      usable.reduce((s, l) => s + usd(l.agent, pair.agent), 0) / usable.length;
    const replay =
      usable.reduce((s, l) => s + usd(l.hotpath, pair.replay), 0) /
      usable.length;
    return {
      label: pair.label,
      runs: usable.length,
      agentUsdPerRun: agent,
      replayUsdPerRun: replay,
      cheaper: replay > 0 ? agent / replay : Infinity,
      runsPerDay,
      agentUsdPerMonth: agent * runsPerDay * 30,
      replayUsdPerMonth: replay * runsPerDay * 30,
    };
  });
}
