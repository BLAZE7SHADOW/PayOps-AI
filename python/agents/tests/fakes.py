"""A fake of the TypeScript API's `/internal/agent` routes, serving the exported fixture, for offline runs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FIXTURE = Path(__file__).parent / "fixtures" / "captured_order_failed.json"


class FakeNodeApi:
    def __init__(self, tier: str = "AUTO", verdicts: list[str] | None = None) -> None:
        data = json.loads(FIXTURE.read_text())
        self.data = data
        self.tier = tier
        self.verdicts = verdicts or ["PASS"]
        self.steps: list[tuple[str, str]] = []
        self.calls: list[str] = []
        self.closed: list[tuple[str, str]] = []
        self.synced: list[tuple[dict[str, Any], bool]] = []
        self.failed: list[str] = []

    async def case_brief(self, case_id: str) -> dict[str, Any]:
        self.calls.append("case_brief")
        return {"brief": self.data["brief"], "entityRefs": self.data["entityRefs"]}

    async def run_tools(self, case_id: str, tools: list[str]) -> list[dict[str, Any]]:
        self.calls.append("run_tools:" + ",".join(tools))
        return [{"tool": t, "drafts": self.data["tools"][t]} for t in tools]

    async def proposal(self, case_id: str, diagnosis: dict[str, Any], history: list[dict[str, Any]]) -> dict[str, Any]:
        self.calls.append("proposal")
        return {"actions": self.data["proposalActions"], "rationale": diagnosis["narrative"], "expectedPostconditions": []}

    async def policy_gate(self, case_id: str, run_id: str, proposal: dict[str, Any], diagnosis_confidence: float) -> dict[str, Any]:
        self.calls.append("policy_gate")
        return {
            "resolutionId": "res_fake",
            "policy": {"tier": self.tier, "reasons": []},
            "attempt": len(self.closed) + 1,
            "approvalId": None if self.tier == "AUTO" else "apr_fake",
        }

    async def execute(self, case_id: str, run_id: str, resolution_id: str) -> dict[str, Any]:
        self.calls.append("execute")
        return {"outcome": "OK", "steps": [{"action": "REPLAY_WEBHOOK_EVENT", "ok": True}]}

    async def validate(self, resolution_id: str) -> dict[str, Any]:
        self.calls.append("validate")
        verdict = self.verdicts.pop(0) if len(self.verdicts) > 1 else self.verdicts[0]
        return {"verdict": verdict, "checks": [{"id": "ledger_credit_posted", "pass": verdict == "PASS"}]}

    async def close_validated(self, case_id: str, run_id: str, resolution_id: str, verdict: str) -> None:
        self.calls.append("close_validated")
        self.closed.append((resolution_id, verdict))

    async def escalate_without_proposal(self, case_id: str, run_id: str, reason: str) -> None:
        self.calls.append("escalate_without_proposal")

    async def record_step(self, run_id: str, case_id: str, node: str, kind: str, payload: dict[str, Any]) -> None:
        self.steps.append((node, kind))

    async def sync(self, run_id: str, case_id: str, state: dict[str, Any], interrupted: bool) -> None:
        self.synced.append((state, interrupted))

    async def fail(self, run_id: str, error: str) -> None:
        self.failed.append(error)
