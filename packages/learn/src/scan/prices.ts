// Model list prices, USD per 1M tokens, for traces that carry token counts but
// no cost. Copied from bench/src/price.ts (a script, so it cannot be imported);
// re-check before quoting, providers change prices often. A model that is not
// here is not priced: pass --price <model>=<in>/<out> instead of guessing.

export interface ModelPrice {
  inPer1M: number;
  outPer1M: number;
}

export const LIST_PRICES: Array<{ model: string } & ModelPrice> = [
  { model: "claude-opus-5-5", inPer1M: 4, outPer1M: 20 },
  { model: "claude-sonnet-5-5", inPer1M: 2, outPer1M: 10 },
  { model: "claude-haiku-5-5", inPer1M: 0.1, outPer1M: 0.5 },
  { model: "deepseek-v4-pro", inPer1M: 1.32, outPer1M: 3.96 },
  { model: "deepseek-flash", inPer1M: 0.3, outPer1M: 1.2 },
  { model: "gpt-6-astra", inPer1M: 10, outPer1M: 50 },
  { model: "gpt-6-luna", inPer1M: 0.1, outPer1M: 0.5 },
];

export const PRICES_SOURCE =
  "model list prices in bench/src/price.ts (Anthropic price table 2026-11-03; others from third-party trackers, 2026-11)";

/** The price of a model name: the longest listed name it starts with. */
export function priceOf(
  model: string,
  extra: Record<string, ModelPrice> = {},
): ModelPrice | null {
  const name = model.toLowerCase();
  const table = [
    ...Object.entries(extra).map(([m, p]) => ({
      model: m.toLowerCase(),
      ...p,
    })),
    ...LIST_PRICES,
  ].sort((a, b) => b.model.length - a.model.length);
  return table.find((p) => name.startsWith(p.model)) ?? null;
}

/** "model=in/out" as given on the command line (USD per 1M tokens). */
export function parsePriceArg(text: string): {
  model: string;
  price: ModelPrice;
} {
  const m = /^(.+)=(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(text);
  if (!m)
    throw new Error(
      `bad --price "${text}": write it as <model>=<input>/<output>, USD per 1M tokens, e.g. gpt-4.1=2/8`,
    );
  return {
    model: m[1]!,
    price: { inPer1M: Number(m[2]), outPer1M: Number(m[3]) },
  };
}
