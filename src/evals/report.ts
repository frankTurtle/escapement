import type { GateResult } from "./baseline.ts";
import type { CaseResult, SuiteResult } from "./types.ts";

const bar = (score: number, width = 10): string => {
  const filled = Math.round(score * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
};

const mark = (result: CaseResult): string => (result.passed ? "PASS" : result.critical ? "FAIL*" : "FAIL");

/** Plain-text summary for a terminal. */
export function renderText(result: SuiteResult): string {
  const lines: string[] = [`\n${result.suiteId} — ${result.passed} passed, ${result.failed} failed\n`];

  for (const c of result.cases) {
    lines.push(`  ${mark(c).padEnd(6)} ${bar(c.score)} ${c.score.toFixed(3)}  ${c.caseId}`);
    if (c.error) lines.push(`         harness error: ${c.error}`);
    for (const g of c.grades.filter((g) => !g.passed)) {
      lines.push(`         ✗ ${g.graderId}: ${g.reason}`);
    }
  }

  lines.push(`\n  score ${result.score.toFixed(3)}  ${bar(result.score, 24)}`);
  if (result.criticalFailures.length > 0) {
    lines.push(`  critical failures: ${result.criticalFailures.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Markdown, for a PR comment or a GitHub step summary. */
export function renderMarkdown(gateResult: GateResult): string {
  const { result, baseline, findings, ok } = gateResult;
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  const infos = findings.filter((f) => f.severity === "info");

  const lines: string[] = [
    `## Eval gate — ${ok ? "passed" : "failed"}`,
    "",
    `**${result.suiteId}** · ${result.passed} passed, ${result.failed} failed · score ${result.score.toFixed(3)} (baseline ${baseline.aggregate.score.toFixed(3)})`,
    "",
  ];

  if (errors.length > 0) {
    lines.push("### Blocking", "");
    for (const f of errors) lines.push(`- **${f.kind}** — ${f.message}`);
    lines.push("");
  }
  if (warnings.length > 0) {
    lines.push("### Worth a look", "");
    for (const f of warnings) lines.push(`- **${f.kind}** — ${f.message}`);
    lines.push("");
  }
  if (infos.length > 0) {
    lines.push("### Improvements", "");
    for (const f of infos) lines.push(`- ${f.message}`);
    lines.push("");
  }

  lines.push("### Cases", "", "| | case | score | baseline | Δ | steps | tools | tokens |", "| - | - | - | - | - | - | - | - |");
  for (const c of result.cases) {
    const recorded = baseline.cases[c.caseId];
    const delta = recorded ? c.score - recorded.score : null;
    lines.push(
      `| ${c.passed ? "✅" : "❌"} | \`${c.caseId}\`${c.critical ? " ⚠️" : ""} | ${c.score.toFixed(3)} | ${
        recorded ? recorded.score.toFixed(3) : "—"
      } | ${delta === null ? "new" : delta === 0 ? "·" : `${delta > 0 ? "+" : ""}${delta.toFixed(3)}`} | ${
        c.usage.modelCalls
      } | ${c.usage.toolCalls} | ${c.usage.totalTokens} |`,
    );
  }

  const failing = result.cases.filter((c) => !c.passed);
  if (failing.length > 0) {
    lines.push("", "### Why they failed", "");
    for (const c of failing) {
      lines.push(`**\`${c.caseId}\`**`, "");
      if (c.error) lines.push(`- harness error: ${c.error}`);
      for (const g of c.grades.filter((g) => !g.passed)) lines.push(`- \`${g.graderId}\` — ${g.reason}`);
      lines.push("");
    }
  }

  lines.push(
    "",
    "> The baseline is re-recorded only on a `release/*` branch (ADR-0012). If a movement here is",
    "> correct, say so in the PR description and leave the gate red — do not re-record to go green.",
  );

  return lines.join("\n");
}

export const renderJson = (gateResult: GateResult): string =>
  JSON.stringify({ ok: gateResult.ok, findings: gateResult.findings, result: gateResult.result }, null, 2);
