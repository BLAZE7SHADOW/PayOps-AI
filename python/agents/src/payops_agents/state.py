"""LangGraph state (docs/03 §6; packages/agents state.ts). Plain dicts in the JSON shapes the API uses.

`evidence` and `findings` merge by id, `agentsVisited` and `history` append, `budget` adds; everything else
keeps the last value written.
"""

from __future__ import annotations

from typing import Annotated, Any, TypedDict

from .budget import add_budgets


def merge_by_id(a: list[dict[str, Any]] | None, b: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    by_id = {x["id"]: x for x in (a or [])}
    for x in b or []:
        by_id[x["id"]] = x
    return list(by_id.values())


def append_lists(a: list[Any] | None, b: list[Any] | None) -> list[Any]:
    return [*(a or []), *(b or [])]


class PayOpsState(TypedDict, total=False):
    caseId: str
    runId: str
    aiMode: str
    scenarioKey: str | None
    case: dict[str, Any] | None
    entityRefs: dict[str, Any]
    investigationPlan: dict[str, Any] | None
    investigationRound: int
    gaps: list[dict[str, Any]]
    evidence: Annotated[list[dict[str, Any]], merge_by_id]
    findings: Annotated[list[dict[str, Any]], merge_by_id]
    agentsVisited: Annotated[list[str], append_lists]
    risk: dict[str, Any] | None
    grounding: dict[str, Any] | None
    diagnosis: dict[str, Any] | None
    proposal: dict[str, Any] | None
    policy: dict[str, Any] | None
    approval: dict[str, Any] | None
    resolutionId: str | None
    approvalId: str | None
    executions: list[dict[str, Any]]
    validation: dict[str, Any] | None
    attempt: int
    history: Annotated[list[dict[str, Any]], append_lists]
    budget: Annotated[dict[str, Any], add_budgets]
    status: str
    error: str | None


def initial_state(case_id: str, run_id: str, ai_mode: str, scenario_key: str | None) -> PayOpsState:
    from .budget import zero_budget

    return {
        "caseId": case_id,
        "runId": run_id,
        "aiMode": ai_mode,
        "scenarioKey": scenario_key,
        "case": None,
        "entityRefs": {},
        "investigationPlan": None,
        "investigationRound": 0,
        "gaps": [],
        "evidence": [],
        "findings": [],
        "agentsVisited": [],
        "risk": None,
        "grounding": None,
        "diagnosis": None,
        "proposal": None,
        "policy": None,
        "approval": None,
        "resolutionId": None,
        "approvalId": None,
        "executions": [],
        "validation": None,
        "attempt": 1,
        "history": [],
        "budget": zero_budget(),
        "status": "INVESTIGATING",
        "error": None,
    }
