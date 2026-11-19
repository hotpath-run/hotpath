// Three views of one ScanResult: text for the terminal, JSON, and one
// self-contained HTML file. All say "estimate", and none holds an argument
// value or a run id: only tool names, argument names and counts.
import type { ScanResult } from "./scan.js";

export const PRIVACY_LINE =
  "This scan ran on your machine. Nothing was sent anywhere, no model was called, and no tool argument values are in this report: only tool names, argument names and counts.";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const n = (x: number) => x.toLocaleString("en-US");
const usd = (x: number) =>
  x >= 100
    ? `$${Math.round(x).toLocaleString("en-US")}`
    : x >= 1
      ? `$${x.toFixed(2)}`
      : `$${x.toFixed(4)}`;
const plural = (c: number, w: string) => `${n(c)} ${w}${c === 1 ? "" : "s"}`;

/** The one sentence a founder would repeat. */
export function headline(r: ScanResult): string {
  if (r.runs === 0) return "No runs were found in these traces.";
  if (r.compilablePaths === 0)
    return `None of your ${plural(r.runs, "run")} followed a path that repeated cleanly ${r.hotAfter} times yet, so there is nothing to compile from these traces.`;
  const base = `${pct(r.potentialHitRate)} of your ${plural(r.runs, "run")} followed ${plural(r.compilablePaths, "path")} that repeat cleanly.`;
  if (!r.monthly) return base;
  return `${base} Estimated saving: ${usd(r.monthly.savingLowUsd)} to ${usd(r.monthly.savingHighUsd)} a month.`;
}

/** Plain-language notes on what limits the numbers. */
export function caveats(r: ScanResult): string[] {
  const out: string[] = [];
  out.push(
    "Every number here is an estimate from your traces, not a measurement of Hotpath on your agent.",
  );
  if (r.monthly) {
    out.push(
      `Saving = what those runs cost today, minus what a replay would cost. A replay costs ${pct(r.assumptions.replayShareLow)} to ${pct(r.assumptions.replayShareHigh)} of an agent run in our measurements (the low end if no run falls back to the agent, the high end if one in ten does).`,
    );
    out.push(r.assumptions.limit);
    out.push(
      `Monthly figures assume the traces cover ${r.days.toFixed(r.days < 10 ? 1 : 0)} day${r.days === 1 ? "" : "s"}${r.daysAssumed ? " (the traces span less than a day, so one day is assumed: use --days if that is wrong)" : ""} and scale to 30 days.`,
    );
    if (r.monthly.extrapolated)
      out.push(
        `Cost was known for ${n(r.usage.costKnownRuns)} of ${n(r.compilableRuns)} compilable runs; the rest use the average of those.`,
      );
  } else if (r.compilablePaths > 0) {
    out.push(
      "No dollar figure: these traces carry no cost or token counts for the compilable runs (or the model has no listed price). Add --price <model>=<in>/<out> or --run-cost <usd> to get one.",
    );
  }
  if (r.usage.unpricedModels.length > 0)
    out.push(
      `No list price for: ${r.usage.unpricedModels.join(", ")}. Runs on those models are not priced unless you pass --price.`,
    );
  if (r.runsWithoutResults > 0)
    out.push(
      `${n(r.runsWithoutResults)} run${r.runsWithoutResults === 1 ? "" : "s"} had no tool results in the export, so loops over a list may be counted as different paths. The real hit rate can only be higher.`,
    );
  out.push(
    "Hit rate counts clean runs (no tool error, run finished) on paths seen at least " +
      `${r.hotAfter} times. Whether a compiled path would pass Hotpath's own checks is only known by running it.`,
  );
  return out;
}

export function formatScanText(r: ScanResult): string {
  const L: string[] = [];
  L.push("Hotpath savings scan (estimate)", "");
  L.push(headline(r), "");
  if (r.runs > 0) {
    L.push(
      `Runs scanned:            ${n(r.runs)}  (${Object.entries(r.sources)
        .map(([s, c]) => `${c} from ${s}`)
        .join(", ")})`,
      `Runs on repeated paths:  ${n(r.compilableRuns)} (${pct(r.potentialHitRate)})  <- estimated hit rate`,
      `  after the first ${r.hotAfter} runs of each path go to your agent to learn: ${pct(r.hitRateAfterWarmup)} in these traces`,
      `Repeated paths:          ${n(r.compilablePaths)} of ${n(r.distinctPaths)} different paths`,
    );
    if (r.failedRuns > 0)
      L.push(
        `Runs with an error:      ${n(r.failedRuns)} (not counted as repeated)`,
      );
    if (r.runsWithoutToolCalls > 0)
      L.push(`Runs with no tool call:  ${n(r.runsWithoutToolCalls)}`);
    L.push("");
    if (r.usage.inputTokens + r.usage.outputTokens > 0) {
      L.push(
        `Model use on those runs: ${n(r.usage.inputTokens)} input + ${n(r.usage.outputTokens)} output tokens` +
          (r.usage.models.length
            ? ` (${r.usage.models.slice(0, 3).join(", ")})`
            : ""),
      );
    }
    if (r.usage.costKnownRuns > 0)
      L.push(
        `Cost of those runs:      ${usd(r.usage.costUsd)} in these traces`,
      );
    if (r.monthly) {
      L.push(
        `Per month, 30 days:      ${usd(r.monthly.agentUsd)} spent on repeated paths`,
        `Estimated saving:        ${usd(r.monthly.savingLowUsd)} to ${usd(r.monthly.savingHighUsd)} a month`,
      );
    }
    if (r.topPaths.length > 0) {
      L.push("", "Most repeated paths (tool sequence, clean runs):");
      r.topPaths.slice(0, 5).forEach((p, i) => {
        L.push(
          `  ${i + 1}. ${p.cleanRuns} run${p.cleanRuns === 1 ? "" : "s"}${p.compilable ? "" : " (not enough yet)"}${p.avgCostUsd !== null ? `, about ${usd(p.avgCostUsd)} each` : ""}`,
          `     ${p.steps.map(shortStep).join(" → ")}`,
        );
      });
    }
  }
  L.push("", "Read this as an estimate:");
  for (const c of caveats(r)) L.push(`  - ${c}`);
  L.push("", PRIVACY_LINE);
  return L.join("\n");
}

/** `tool!(a:value, b:result)*` is exact but noisy: show the tool name only. */
function shortStep(step: string): string {
  const m = /^([^(]+?)!?\(/.exec(step);
  const name = m ? m[1]! : step;
  return step.endsWith("*") ? `${name} (per item)` : name;
}

export function formatScanJson(r: ScanResult): string {
  return JSON.stringify(
    { ...r, caveats: caveats(r), privacy: PRIVACY_LINE },
    null,
    2,
  );
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function formatScanHtml(r: ScanResult): string {
  const stat = (value: string, label: string) =>
    `<div class="stat"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
  const stats = [
    stat(pct(r.potentialHitRate), "estimated hit rate"),
    stat(n(r.compilablePaths), "repeated paths"),
    stat(`${n(r.compilableRuns)} of ${n(r.runs)}`, "runs on those paths"),
    ...(r.monthly
      ? [
          stat(
            `${usd(r.monthly.savingLowUsd)} – ${usd(r.monthly.savingHighUsd)}`,
            "estimated saving a month",
          ),
        ]
      : []),
  ].join("");
  const rows = r.topPaths
    .map(
      (p, i) =>
        `<tr><td>${i + 1}</td><td class="steps">${p.steps
          .map((s) => `<span>${esc(shortStep(s))}</span>`)
          .join(
            "<i>→</i>",
          )}</td><td class="num">${n(p.cleanRuns)}</td><td class="num">${p.avgCostUsd !== null ? esc(usd(p.avgCostUsd)) : "–"}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hotpath savings scan</title>
<style>
:root{--bg:#fff;--fg:#14171a;--mute:#5b6570;--card:#f4f6f8;--line:#d9dee3;--acc:#0b6b3a}
@media(prefers-color-scheme:dark){:root{--bg:#101316;--fg:#eceff1;--mute:#9aa5ae;--card:#1a1f24;--line:#2c343b;--acc:#52d68a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 48px}
h1{font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin:0 0 8px}
.head{font-size:24px;line-height:1.3;font-weight:650;margin:0 0 20px}
.tag{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:1px 10px;font-size:13px;color:var(--mute);margin-left:8px;vertical-align:middle}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:28px}
.stat{background:var(--card);border-radius:10px;padding:14px}.v{font-size:24px;font-weight:700;color:var(--acc)}.l{color:var(--mute);font-size:14px}
h2{font-size:18px;margin:28px 0 8px}
table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mute);font-weight:500;font-size:13px}.num{text-align:right;white-space:nowrap}
.steps span{display:inline-block;background:var(--card);border-radius:5px;padding:0 6px;margin:2px 0;font:13px ui-monospace,monospace}.steps i{color:var(--mute);margin:0 4px;font-style:normal}
ul{padding-left:20px;color:var(--mute);font-size:15px}li{margin:4px 0}
.priv{margin-top:24px;padding:12px 14px;border-left:3px solid var(--acc);background:var(--card);border-radius:0 8px 8px 0;font-size:15px}
</style></head><body><main>
<h1>Hotpath savings scan<span class="tag">estimate</span></h1>
<p class="head">${esc(headline(r))}</p>
<div class="stats">${stats}</div>
<h2>Most repeated paths</h2>
${rows ? `<table><thead><tr><th>#</th><th>Tool sequence</th><th class="num">Clean runs</th><th class="num">Cost each</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No repeated path yet.</p>"}
<h2>How to read this</h2>
<ul>${caveats(r)
    .map((c) => `<li>${esc(c)}</li>`)
    .join("")}</ul>
<div class="priv">${esc(PRIVACY_LINE)}</div>
</main></body></html>
`;
}
