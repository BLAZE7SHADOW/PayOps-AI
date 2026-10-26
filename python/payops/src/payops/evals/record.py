"""Records real Gemini and Jev responses into `fixtures/cassettes/<scenario>.jsonl` so REPLAY (tests, evals, the hosted demo) never calls a provider. Only
model responses are recorded; the graph, tools, database, policy, executor and validator run for real against a throwaway Postgres.

    uv run python -m payops.evals.record                 # records the (scenario, seed) pairs missing from manifest.json
    uv run python -m payops.evals.record --only refund_stuck,duplicate_capture
    uv run python -m payops.evals.record --all           # clears each scenario's cassette first and records everything again

This makes real, billed calls and needs GEMINI_API_KEY and TYPESAFE_JEV_API_KEY (read from the environment, never printed). Run it in a normal terminal
with `--env-file`, for example `uv run --env-file ../../.env python -m payops.evals.record`. Commit `fixtures/cassettes/` afterwards. (record-cassettes.ts)"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
from contextlib import AsyncExitStack
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from payops_agents.cassette import cassette_path, default_cassette_dir
from payops_agents.checkpointer import create_checkpointer
from payops_agents.ports import ModelEnv
from payops_agents.run import AgentRunner
from payops_agents.settings import Settings as AgentSettings
from pgserver.postgres_server import get_server

from ..agent_tools.node_api import InProcessNodeApi
from ..agent_tools.store import AgentStore
from ..api.security import SessionUser
from ..container import Services, build_services
from ..db.engine import create_engine, session_factory
from ..db.migrate import upgrade
from ..domain.ids import new_id
from ..dto.resolution import ApprovalDecisionBody
from ..ports import FixedClock
from .runner import SharedIntakeFixture

NOW = datetime.fromisoformat("2026-09-28T12:00:00+00:00")
MAX_APPROVALS = 3


@dataclass(frozen=True)
class Spec:
    scenario: str
    seed: int
    #: A different diagnosis is only noted, unless `strict_diagnosis` is set.
    expect_root_cause: str | None = None
    #: The run must end RESOLVED with verdict PASS.
    strict: bool = False
    strict_diagnosis: bool = False


# Every fault scenario, two seeds each, so the hosted REPLAY demo has plenty to show. Seeds 3201 to 3203 are the original recordings.
SPECS: tuple[Spec, ...] = (
    Spec("captured_order_failed", 3201, "WEBHOOK_PROCESSING_FAILURE", strict=True),
    Spec("refund_stuck", 3202, "REFUND_STATUS_NOT_SYNCED", strict=True),
    Spec("refund_never_initiated", 3203, "REFUND_NOT_INITIATED", strict=True),
    Spec("settlement_mismatch", 3204),
    Spec("duplicate_capture", 3205),
    Spec("suspicious_payment", 3206),
    Spec("replay_fails_then_replan", 3207),
    Spec("injected_refund_request", 3208),
    Spec("captured_order_failed", 3211),
    Spec("refund_stuck", 3212),
    Spec("refund_never_initiated", 3213),
    Spec("settlement_mismatch", 3214),
    Spec("duplicate_capture", 3215),
    Spec("suspicious_payment", 3216),
    Spec("replay_fails_then_replan", 3217),
    Spec("injected_refund_request", 3218),
    Spec("misleading_note", 3401, "WEBHOOK_PROCESSING_FAILURE"),
    Spec("conflicting_evidence", 3402, "REFUND_NOT_INITIATED"),
    Spec("showcase_webhook_recovery", 3301, "WEBHOOK_PROCESSING_FAILURE", strict=True, strict_diagnosis=True),
    Spec("showcase_duplicate_capture", 3302, "DUPLICATE_CAPTURE", strict=True, strict_diagnosis=True),
    Spec("showcase_settlement_dispute", 3304, "SETTLEMENT_FEE_MISMATCH", strict=True, strict_diagnosis=True),
    Spec("showcase_ledger_gap", 3306, "LEDGER_POSTING_MISSING", strict=True, strict_diagnosis=True),
)


def manifest_path(directory: Path) -> Path:
    return directory / "manifest.json"


def read_manifest(directory: Path) -> list[dict[str, Any]]:
    path = manifest_path(directory)
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def upsert_manifest(directory: Path, entry: dict[str, Any]) -> None:
    rest = [e for e in read_manifest(directory) if not (e["scenario"] == entry["scenario"] and e["seed"] == entry["seed"])]
    merged = sorted([*rest, entry], key=lambda e: e["seed"])
    manifest_path(directory).write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def select(specs: tuple[Spec, ...], done: set[tuple[str, int]], *, everything: bool, only: set[str] | None) -> list[Spec]:
    return [s for s in specs if (only is None or s.scenario in only) and (everything or (s.scenario, s.seed) not in done)]


async def record_one(services: Services, runner: AgentRunner, store: AgentStore, spec: Spec, env: ModelEnv, directory: Path, *, fresh_file: bool) -> dict[str, Any]:
    path = cassette_path(spec.scenario, directory)
    # The recorder only appends, so a full re-record of a scenario starts from an empty file.
    if fresh_file and path.exists():
        path.unlink()
    print(f"\n=== {spec.scenario} (seed {spec.seed}) ===", file=sys.stderr)
    generated = await services.simulator.generate_scenario(spec.scenario, spec.seed)
    if not generated.cases_opened:
        raise RuntimeError(f"{spec.scenario} seed {spec.seed}: detection opened no case")
    case_id = generated.cases_opened[0]["id"]
    run_id = new_id("run")
    await store.create_run(run_id, case_id, spec.scenario)
    result = await runner.investigate(run_id, case_id, spec.scenario, env.ai_mode, env)

    # A manager can approve any tier, so play that role until the run stops asking.
    for _ in range(MAX_APPROVALS):
        if not result.interrupted:
            break
        approval_id = result.state["approvalId"]
        print(f"  status={result.state.get('status')} tier={(result.state.get('policy') or {}).get('tier')}; approving as manager", file=sys.stderr)
        manager = SessionUser(id="usr_record_manager", email="record@payops.dev", name="Recording manager", role="MANAGER")
        await services.approval_service.decide(approval_id, ApprovalDecisionBody(decision="APPROVE", comment=""), manager)
        decision = {"approvalId": approval_id, "decision": "APPROVE", "decidedBy": None, "comment": None}
        result = await runner.resume(run_id, case_id, spec.scenario, env.ai_mode, decision, env)

    state = result.state
    status = state.get("status")
    verdict = (state.get("validation") or {}).get("verdict")
    tier = (state.get("policy") or {}).get("tier")
    root_cause = (state.get("diagnosis") or {}).get("rootCause")
    print(f"  status={status} tier={tier} verdict={verdict} rootCause={root_cause}", file=sys.stderr)
    if spec.strict and (status != "RESOLVED" or verdict != "PASS"):
        raise RuntimeError(f"{spec.scenario}: expected RESOLVED/PASS, got status={status} verdict={verdict}")
    if spec.expect_root_cause and root_cause != spec.expect_root_cause:
        if spec.strict_diagnosis:
            raise RuntimeError(f"{spec.scenario}: expected root cause {spec.expect_root_cause}, got {root_cause}")
        print(f"  NOTE: the model diagnosed {root_cause}, not {spec.expect_root_cause} (see fixtures/cassettes/README.md)", file=sys.stderr)
    entry = {
        "scenario": spec.scenario, "seed": spec.seed, "status": str(status), "tier": tier, "verdict": verdict, "rootCause": root_cause,
        "recordedAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    upsert_manifest(directory, entry)
    print(f"  wrote {path}", file=sys.stderr)
    return entry


async def record(specs: list[Spec], env: ModelEnv, directory: Path, *, everything: bool) -> list[dict[str, Any]]:
    """Runs each spec on a fresh database and writes its cassette and manifest entry into `directory`."""
    with tempfile.TemporaryDirectory(prefix="payops-record-") as data_dir:
        server = get_server(data_dir)
        url = server.get_uri()
        upgrade(url)
        engine = create_engine(url=url, pool_size=5)
        try:
            services = build_services(session_factory(engine), clock=FixedClock(NOW), cassette_dir=directory)
            services.signal_intake.decision = SharedIntakeFixture()
            services.approval_service.agent_resumer = None
            store = AgentStore(services.sessions, services.clock, services.events)
            entries: list[dict[str, Any]] = []
            seen: set[str] = set()
            async with AsyncExitStack() as stack:
                checkpointer = await create_checkpointer(stack, AgentSettings(checkpointer="memory"))
                runner = AgentRunner(InProcessNodeApi(services, store), checkpointer)
                for spec in specs:
                    first = everything and spec.scenario not in seen
                    seen.add(spec.scenario)
                    entries.append(await record_one(services, runner, store, spec, env, directory, fresh_file=first))
            return entries
        finally:
            await engine.dispose()
            server.cleanup()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m payops.evals.record", description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--all", action="store_true", help="clear each scenario's cassette and record everything again")
    parser.add_argument("--only", help="comma-separated scenario names")
    args = parser.parse_args(argv)

    env = ModelEnv.from_environ("RECORD")
    if not env.gemini_api_key or not env.jev_api_key:
        print("GEMINI_API_KEY and TYPESAFE_JEV_API_KEY must both be set to record cassettes.", file=sys.stderr)
        return 1
    directory = default_cassette_dir()
    os.environ["CASSETTE_DIR"] = str(directory)
    done = {(e["scenario"], e["seed"]) for e in read_manifest(directory)}
    todo = select(SPECS, done, everything=args.all, only=set(args.only.split(",")) if args.only else None)
    if not todo:
        print("Nothing to record: every scenario and seed is in manifest.json (use --all to redo).", file=sys.stderr)
        return 0
    print(f"Recording {len(todo)} run(s) with AI_MODEL={env.ai_model} JEV_MODEL={env.jev_model} (real, billed calls)", file=sys.stderr)
    asyncio.run(record(todo, env, directory, everything=args.all))
    print(f"\nRecorded {len(todo)} run(s). Next: run the tests and the evals, then commit fixtures/cassettes/.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
