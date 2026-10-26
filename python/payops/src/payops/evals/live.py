"""`python -m payops.evals.live`: the golden scenarios that use real model answers, run against the real Gemini and Jev.

The regular suite replays recordings, so it can only tell you that the code still behaves as it did when the answers were recorded. This
run asks the live providers the same questions today. It catches what replay cannot: a model update that changes an answer, a prompt
that no longer works, an API that changed shape. It makes **real, billed calls**, so it never runs on a push: start it by hand or from the
weekly workflow (`.github/workflows/live-eval.yml`).

Live answers vary between runs, so this run is not compared with the baseline. It must pass the same per-scenario gates and aggregate
limits as the replay suite, and its JSON report is kept so the results can be watched over time.

    uv run --env-file ../../.env python -m payops.evals.live --report live-eval-report.json
    uv run --env-file ../../.env python -m payops.evals.live --only refund_stuck,duplicate_capture --max-cost 0.25
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from payops_agents.ports import ModelEnv

from .__main__ import step_summary
from .baseline import dumps, make_report
from .golden import GOLDEN_SCENARIOS, Golden
from .report import RunOutcome, check_thresholds, render, summarize

#: Stop starting new scenarios once a live run has cost this much (USD). The suite is a few cents; this is a safety net.
DEFAULT_MAX_COST_USD = 0.50


def live_goldens(only: set[str] | None = None) -> tuple[Golden, ...]:
    """Scenarios whose answers come from the providers (the cassette-driven ones). The fixture ones never call a model, so running them
    live would only repeat the replay suite."""
    return tuple(
        g for g in GOLDEN_SCENARIOS if g.fixture is None and (only is None or g.scenario in only or g.key in only)
    )


def problems_for(outcomes: list[RunOutcome], expected: int) -> list[str]:
    summary = summarize(outcomes)
    problems = [f"scenario {o.key} failed its gates" for o in outcomes if not o.ok]
    problems += check_thresholds(summary)
    if len(outcomes) < expected:
        problems.append(f"stopped at the cost cap after {len(outcomes)} of {expected} scenarios")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m payops.evals.live", description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--report", type=Path, help="write the full JSON record of this run here")
    parser.add_argument("--only", help="comma-separated scenario names or golden keys")
    parser.add_argument(
        "--max-cost", type=float, default=DEFAULT_MAX_COST_USD, help="stop starting scenarios past this many USD"
    )
    args = parser.parse_args(argv)

    env = ModelEnv.from_environ("LIVE")
    if not env.gemini_api_key or not env.jev_api_key:
        print("GEMINI_API_KEY and TYPESAFE_JEV_API_KEY must both be set for a live eval.", file=sys.stderr)
        return 1
    goldens = live_goldens(set(args.only.split(",")) if args.only else None)
    if not goldens:
        print("No scenario matches --only.", file=sys.stderr)
        return 1
    print(
        f"Live eval of {len(goldens)} scenarios with AI_MODEL={env.ai_model} JEV_MODEL={env.jev_model} (real, billed calls)",
        file=sys.stderr,
    )

    from .__main__ import run_suite  # the throwaway database wrapper, shared with the replay run

    outcomes = asyncio.run(run_suite(goldens, ai_mode="LIVE", model_env=env, max_cost_usd=args.max_cost))
    summary = summarize(outcomes)
    print(render(outcomes, summary))
    problems = problems_for(outcomes, len(goldens))
    for p in problems:
        print(f"PROBLEM: {p}")
    if args.report:
        report = make_report(outcomes, summary, None, commit=os.environ.get("GITHUB_SHA"))
        report["aiMode"] = "LIVE"
        report["models"] = {"gemini": env.ai_model, "jev": env.jev_model}
        args.report.write_text(dumps(report), encoding="utf-8")
        print(f"Report written to {args.report}")
    if github_summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(github_summary, "a", encoding="utf-8") as f:
            f.write(
                step_summary(summary, None, problems).replace("Golden evals", "Live evals (real Gemini and Jev)", 1)
            )
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
