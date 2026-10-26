"""Helpers shared by the graph nodes (ported from packages/agents nodes/shared.ts)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, cast

from ..budget import add_budgets, check_budget_guard, zero_budget
from ..constants import estimate_call_cost_usd
from ..node_api import NodeApiPort
from ..ports import DecisionPort, LlmPort
from ..runids import next_evidence_id, next_finding_id
from ..shapes import Evidence

State = dict[str, Any]
Update = dict[str, Any]
Node = Callable[[State], Awaitable[Update]]
EventSink = Callable[[str, str, dict[str, Any]], Awaitable[None]]
GuardBudget = Callable[[str, State, Update], Awaitable[Update]]


@dataclass
class AgentDeps:
    api: NodeApiPort
    llm: LlmPort
    decision: DecisionPort
    on_event: EventSink


@dataclass
class NodeContext:
    """What every node builder receives."""

    api: NodeApiPort
    llm: LlmPort
    decision: DecisionPort
    on_event: EventSink
    guard_budget: GuardBudget


def create_budget_guard(on_event: EventSink) -> GuardBudget:
    """The budget guard (D049): when a run's total goes over a limit the node still completes, and the graph routes to
    `closeEscalated` next."""

    async def guard_budget(node_name: str, state: State, update: Update) -> Update:
        total = add_budgets(state.get("budget") or zero_budget(), update.get("budget") or zero_budget())
        guard = check_budget_guard(total)
        if not guard.exceeded:
            return update
        await on_event(node_name, "NODE_COMPLETED", {"budgetExceeded": True, "reason": guard.reason, "budget": total})
        return {**update, "status": "ESCALATED", "error": guard.reason}

    return guard_budget


def evidence_from(existing: Sequence[Evidence], results: list[dict[str, Any]], step_id: str) -> list[Evidence]:
    """Turns the API's tool results into evidence items with run-scoped ids, in tool order."""
    created: list[Evidence] = []
    pool = list(existing)
    for result in results:
        for draft in result["drafts"]:
            item = cast(Evidence, {"id": next_evidence_id(pool), "stepId": step_id, **draft})
            created.append(item)
            pool.append(item)
    return created


def jev_budget(usage: dict[str, Any]) -> dict[str, Any]:
    """Budget for one Jev call."""
    tokens_in, tokens_out = usage["input_tokens"], usage["output_tokens"]
    return {
        **zero_budget(),
        "jevCalls": 1,
        "tokensIn": tokens_in,
        "tokensOut": tokens_out,
        "costUsd": estimate_call_cost_usd("jev", tokens_in, tokens_out),
    }


def failed_jev_budget() -> dict[str, Any]:
    """A Jev call that failed still counts as a call, with no usage to price."""
    return {**zero_budget(), "jevCalls": 1}


def decision_state(brief: dict[str, Any]) -> dict[str, Any]:
    """The compact, code-built case facts Jev sees at J2 and J6."""
    return {
        "caseType": brief["type"],
        "detectionRuleIds": brief["detectionRuleIds"],
        "amountBand": brief["amountBand"],
        "mismatchedSystems": brief["mismatchedSystems"],
        "flags": brief["flags"],
    }


def build_findings(
    drafts: Any, agent: str, valid_ids: set[str], existing: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """A finding must cite evidence its own agent gathered: other citations are dropped, and a finding left with none is
    discarded."""
    pool = list(existing)
    findings: list[dict[str, Any]] = []
    for draft in drafts:
        evidence_ids = [i for i in draft.evidenceIds if i in valid_ids]
        if not evidence_ids:
            continue
        finding = {
            "id": next_finding_id(pool),
            "agent": agent,
            "code": draft.code,
            "statement": draft.statement,
            "evidenceIds": evidence_ids,
            "confidence": draft.confidence,
        }
        findings.append(finding)
        pool.append(finding)
    return findings
