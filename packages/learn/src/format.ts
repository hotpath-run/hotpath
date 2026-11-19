import type { LearnReport, PathReport } from "./learn.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function status(p: PathReport): string {
  if (p.live) return "live";
  if (!p.hot) return "not hot yet";
  if (p.candidate?.shadow.ok) return "candidate, shadow check passed";
  return "candidate, shadow check failed";
}

/** What `hotpath learn` prints: every path, how often it ran, what it is now. */
export function formatLearnReport(report: LearnReport): string {
  if (report.paths.length === 0) {
    return "no runs yet: run your agent through hotpath (hotpath record or recordTools) and come back";
  }
  const lines: string[] = [
    `${plural(report.paths.length, "path")} (hot after ${plural(report.hotAfter, "clean run")} in a row)`,
  ];
  for (const p of report.paths) {
    const cost =
      p.costKnownRuns > 0
        ? `, agent cost $${p.costUsd.toFixed(4)} (known for ${p.costKnownRuns} of ${p.runs})`
        : "";
    lines.push(
      "",
      `${p.id}  ${status(p)}`,
      `  ${plural(p.runs, "run")}, ${p.cleanRuns} clean, ${p.servable} a live workflow could have served${cost}`,
      `  ${p.steps.join(" → ")}`,
    );
    for (const problem of p.problems) lines.push(`  ✗ ${problem}`);
    const c = p.candidate;
    if (c && !p.live) {
      for (const problem of c.shadow.problems)
        lines.push(`  ✗ shadow: ${problem}`);
      for (const warning of c.warnings) lines.push(`  ⚠ ${warning}`);
      if (c.fromRuns === 1 && p.cleanRuns > 1) {
        lines.push(
          "  compiled from the newest run alone: the runs together failed the shadow check (their texts disagree)",
        );
      }
      const inputs = Object.keys(c.workflow.inputs);
      lines.push(`  inputs: ${inputs.length > 0 ? inputs.join(", ") : "none"}`);
      if (c.shadow.ok) {
        lines.push(`  make it live: hotpath learn --promote ${p.id}`);
      }
    }
  }
  if (report.promoted.length > 0) {
    lines.push(
      "",
      `promoted: ${report.promoted.join(", ")} (run one with: hotpath run <path> --input …)`,
    );
  }
  if (report.skipped.length > 0) {
    lines.push(
      "",
      `skipped ${plural(report.skipped.length, "unreadable trace")}`,
    );
  }
  return lines.join("\n");
}
