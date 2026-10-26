"""`python -m payops.evals`: runs the golden scenarios in REPLAY against a throwaway Postgres (pgserver, no Docker).

It exits 1 when a scenario gate fails, an aggregate limit is crossed, or the run is worse than the committed baseline
(`fixtures/evals/baseline.json`). After a deliberate change, `--update-baseline` rewrites the baseline; read its diff in review.

    uv run python -m payops.evals
    uv run python -m payops.evals --report eval-report.json     # the full JSON record of the run (CI keeps it)
    uv run python -m payops.evals --update-baseline             # accept this run as the new baseline
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from pgserver.postgres_server import get_server

from ..container import build_services
from ..db.engine import create_engine, session_factory
from ..db.migrate import upgrade
from ..ports import FixedClock
from ..settings import Settings
from .baseline import BASELINE_PATH, Comparison, compare, dumps, load_baseline, make_baseline, make_report
from .report import RunOutcome, Summary, check_thresholds, render, summarize
from .runner import run_eval_suite

NOW = datetime.fromisoformat("2026-09-28T12:00:00+00:00")


async def run_suite() -> list[RunOutcome]:
    with tempfile.TemporaryDirectory(prefix="payops-eval-") as data_dir:
        server = get_server(data_dir)
        url = server.get_uri()
        upgrade(url)
        engine = create_engine(url=url, pool_size=5)
        try:
            services = build_services(session_factory(engine), clock=FixedClock(NOW), cassette_dir=Settings().cassettes)
            return await run_eval_suite(services)
        finally:
            await engine.dispose()
            server.cleanup()


def step_summary(summary: Summary, comparison: Comparison | None, problems: list[str]) -> str:
    """Markdown for the CI run page, so the numbers are visible without opening the log."""
    lines = [
        "### Golden evals",
        "",
        "| Scenarios passing | Root-cause accuracy | Mean tool calls | Replay lookups (exact / fallback) | Cost |",
        "|---|---|---|---|---|",
        f"| {summary.passed}/{summary.total} | {summary.root_cause_accuracy:.1%} | {summary.mean_tool_calls:.1f} "
        f"| {summary.exact_lookups} / {summary.fallback_lookups} | ${summary.total_cost_usd:.4f} |",
        "",
    ]
    if problems:
        lines += ["**Failing:**", *[f"- {p}" for p in problems], ""]
    elif comparison and comparison.improvements:
        lines += [
            "Better than the baseline (consider `--update-baseline`):",
            *[f"- {i}" for i in comparison.improvements],
            "",
        ]
    else:
        lines += ["No change from the baseline.", ""]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m payops.evals", description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--report", type=Path, help="write the full JSON record of this run here")
    parser.add_argument("--baseline", type=Path, default=BASELINE_PATH, help="the committed baseline to compare with")
    parser.add_argument("--update-baseline", action="store_true", help="accept this run as the new baseline")
    args = parser.parse_args(argv)

    outcomes = asyncio.run(run_suite())
    summary = summarize(outcomes)
    print(render(outcomes, summary))

    current = make_baseline(outcomes, summary)
    problems = [f"scenario {o.key} failed its gates" for o in outcomes if not o.ok] + check_thresholds(summary)
    comparison: Comparison | None = None
    baseline = load_baseline(args.baseline)
    if args.update_baseline:
        if problems:
            print("\nNot updating the baseline: the run itself fails.", file=sys.stderr)
        else:
            args.baseline.parent.mkdir(parents=True, exist_ok=True)
            args.baseline.write_text(dumps(current), encoding="utf-8")
            print(f"\nBaseline written to {args.baseline}")
            baseline = current
    if baseline is None:
        problems.append(f"no baseline at {args.baseline}; run with --update-baseline once and commit the file")
    else:
        comparison = compare(baseline, current)
        problems += [f"regression: {r}" for r in comparison.regressions]
        for i in comparison.improvements:
            print(f"IMPROVED: {i}")
    for p in problems:
        print(f"PROBLEM: {p}")

    if args.report:
        report = make_report(outcomes, summary, comparison, commit=os.environ.get("GITHUB_SHA"))
        args.report.write_text(dumps(report), encoding="utf-8")
        print(f"Report written to {args.report}")
    if github_summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(github_summary, "a", encoding="utf-8") as f:
            f.write(step_summary(summary, comparison, problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
