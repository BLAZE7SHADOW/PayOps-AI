"""The cassette recorder's plumbing, with no provider calls: the three original scenarios are driven in REPLAY against a copy of the cassettes, which proves the
run, approval and manifest handling. Real recording (RECORD mode) needs keys and makes billed calls, so it is never run from tests."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from payops_agents.ports import ModelEnv

from payops.evals.record import SPECS, Spec, read_manifest, record, select, upsert_manifest

REPO_CASSETTES = Path(__file__).resolve().parents[3] / "fixtures" / "cassettes"


def test_select_skips_recorded_pairs_unless_everything() -> None:
    done = {("refund_stuck", 3202)}
    assert Spec("refund_stuck", 3202) not in select(SPECS, done, everything=False, only=None)
    assert any(s.scenario == "refund_stuck" and s.seed == 3202 for s in select(SPECS, done, everything=True, only=None))
    only = select(SPECS, set(), everything=True, only={"duplicate_capture"})
    assert {s.scenario for s in only} == {"duplicate_capture"}


def test_every_recorded_pair_in_the_repo_manifest_has_a_spec() -> None:
    manifest = {(e["scenario"], e["seed"]) for e in read_manifest(REPO_CASSETTES)}
    assert manifest <= {(s.scenario, s.seed) for s in SPECS}


def test_upsert_manifest_replaces_a_pair_and_sorts_by_seed(tmp_path: Path) -> None:
    upsert_manifest(tmp_path, {"scenario": "b", "seed": 2, "status": "X"})
    upsert_manifest(tmp_path, {"scenario": "a", "seed": 1, "status": "X"})
    upsert_manifest(tmp_path, {"scenario": "b", "seed": 2, "status": "Y"})
    rows = json.loads((tmp_path / "manifest.json").read_text())
    assert [(r["seed"], r["status"]) for r in rows] == [(1, "X"), (2, "Y")]


@pytest.mark.asyncio
async def test_the_original_three_runs_replay_through_the_recorder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    directory = tmp_path / "cassettes"
    shutil.copytree(REPO_CASSETTES, directory)
    monkeypatch.setenv("CASSETTE_DIR", str(directory))
    before = {(e["scenario"], e["seed"]): e for e in read_manifest(directory)}
    entries = await record(list(SPECS[:3]), ModelEnv(ai_mode="REPLAY"), directory, everything=False)
    assert [(e["status"], e["verdict"]) for e in entries] == [("RESOLVED", "PASS")] * 3
    assert entries[2]["tier"] == "MANAGER"  # refund_never_initiated pauses for a manager, the recorder approves it
    after = {(e["scenario"], e["seed"]): e for e in read_manifest(directory)}
    assert after.keys() == before.keys()
    for key in [(s.scenario, s.seed) for s in SPECS[:3]]:
        assert after[key]["rootCause"] == before[key]["rootCause"]
