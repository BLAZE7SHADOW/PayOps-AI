import { EVAL_THRESHOLDS, checkThresholds, type EvalSummary, type RunOutcome } from './types';

/** What was run, so two reports can be compared fairly. Models and prompts change results. */
export interface ReportMeta {
  gitCommit: string;
  llmModel: string;
  decisionModel: string;
  cassetteScenarios: number;
}

function pct(x: number | null): string {
  return x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

function ms(x: number): string {
  return `${Math.round(x)} ms`;
}

function usd(x: number): string {
  return `$${x.toFixed(4)}`;
}

/** Renders the eval run as the markdown report docs/03-agent-system.md §17 describes:
 * "Metrics reported per run: root-cause accuracy, action-set match, policy-tier match,
 * grounding violation rate, replan success rate, mean tool calls, mean latency, cost per case." */
export function renderMarkdownReport(
  outcomes: readonly RunOutcome[],
  summary: EvalSummary,
  opts: { generatedAt: string; mode: 'REPLAY' | 'LIVE'; meta?: ReportMeta },
): string {
  const lines: string[] = [];
  lines.push(`# Eval report — ${opts.generatedAt}`);
  lines.push('');
  lines.push(`Mode: ${opts.mode}. ${summary.passed}/${summary.total} golden scenarios passed.`);
  lines.push('');
  if (opts.meta) {
    lines.push('## Run details');
    lines.push('');
    lines.push('| Item | Value |');
    lines.push('|---|---|');
    lines.push(`| Commit | ${opts.meta.gitCommit} |`);
    lines.push(`| Gemini model | ${opts.meta.llmModel} |`);
    lines.push(`| Jev model | ${opts.meta.decisionModel} |`);
    lines.push(`| Recorded scenarios (cassette manifest) | ${opts.meta.cassetteScenarios} |`);
    lines.push(
      `| Limits | root-cause accuracy >= ${pct(EVAL_THRESHOLDS.minRootCauseAccuracy)}, action-set match >= ${pct(EVAL_THRESHOLDS.minActionSetMatchRate)}, tool-set match >= ${pct(EVAL_THRESHOLDS.minToolSetMatchRate)}, total cost <= $${EVAL_THRESHOLDS.maxTotalCostUsd.toFixed(2)} |`,
    );
    lines.push('');
  }
  lines.push('## Summary metrics (docs/03 §17)');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Root-cause accuracy | ${pct(summary.rootCauseAccuracy)} |`);
  lines.push(`| Action-set match | ${pct(summary.actionSetMatchRate)} |`);
  lines.push(
    `| Policy-tier match | ${pct(summary.total ? summary.passed / summary.total : null)} (folded into pass/fail — tier is a hard gate) |`,
  );
  lines.push(`| Tool-set match | ${pct(summary.toolSetMatchRate)} |`);
  lines.push(
    `| Full-path runs that dropped a finding | ${pct(summary.runsWithDroppedFindingsRate)} (n/a means no full-path run) |`,
  );
  lines.push(
    `| Findings dropped per full-path run | ${summary.droppedFindingsPerRun === null ? 'n/a' : summary.droppedFindingsPerRun.toFixed(2)} |`,
  );
  lines.push(`| Replan success rate | ${pct(summary.replanSuccessRate)} |`);
  lines.push(`| Mean tool calls | ${summary.meanToolCalls.toFixed(1)} |`);
  lines.push(`| Mean latency | ${ms(summary.meanLatencyMs)} |`);
  lines.push(`| Total cost | ${usd(summary.totalCostUsd)} |`);
  lines.push('');
  const breaches = checkThresholds(summary);
  lines.push(breaches.length === 0 ? 'All aggregate limits met.' : `Aggregate limits breached: ${breaches.join('; ')}.`);
  lines.push('');
  lines.push('## Per-scenario results');
  lines.push('');
  lines.push(
    '| Scenario | Result | Status | Tier | Verdict | Root cause (expected → got) | Actions | Tool set | Attempt | Tool calls | Latency | Cost |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const o of outcomes) {
    const result = o.ok ? 'PASS' : 'FAIL';
    const rc = o.rootCauseMatch
      ? `${o.rootCause}`
      : `${o.expectedRootCause} → ${o.rootCause ?? 'null'}${o.knownRootCauseCaveat ? ' *' : ''}`;
    lines.push(
      `| ${o.key} | ${result} | ${o.status} | ${o.tier ?? '—'} | ${o.verdict ?? '—'} | ${rc} | ${o.actionTypes.join(', ') || '—'} | ${o.toolSetMatch === null ? '—' : o.toolSetMatch ? 'MATCH' : 'MISS'} | ${o.attempt} | ${o.toolCalls} | ${ms(o.latencyMs)} | ${usd(o.costUsd)} |`,
    );
  }
  lines.push('');
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const o of failed) {
      lines.push(`- **${o.key}**: ${o.failures.join('; ')}`);
    }
    lines.push('');
  }
  const caveats = outcomes.filter((o) => o.knownRootCauseCaveat);
  if (caveats.length > 0) {
    lines.push('## Known root-cause caveats (`*` above, excluded from the accuracy metric)');
    lines.push('');
    for (const o of caveats) {
      lines.push(`- **${o.key}**: ${o.knownRootCauseCaveat}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
