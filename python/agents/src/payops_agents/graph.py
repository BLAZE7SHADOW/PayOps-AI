"""Wires the graph (docs/03 §5; packages/agents graph.ts). Same nodes and edges as the TypeScript graph.

The fast path (`diagnose` -> `resolve`) skips `plan`, the specialists, `join` and `groundCheck`. Every edge up
to and including `resolve` checks the budget guard's `ESCALATED` status first and routes to `closeEscalated`.
`groundCheck` can loop back to `plan` once for a targeted round; `replan` loops to `resolve` or `plan`.
"""

from __future__ import annotations

from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from .constants import AGENT_NAMES
from .nodes import AgentDeps, build_nodes
from .state import PayOpsState

SPECIALIST_NODE = {"payment": "paymentAgent", "reconciliation": "reconciliationAgent", "risk": "riskAgent"}


def _escalated(state: dict[str, Any]) -> bool:
    return state.get("status") == "ESCALATED"


def build_graph(deps: AgentDeps, checkpointer: BaseCheckpointSaver[Any]) -> Any:
    nodes = build_nodes(deps)
    graph = StateGraph(PayOpsState)
    for name, fn in nodes.items():
        graph.add_node(name, fn)  # type: ignore[arg-type]

    graph.add_edge(START, "loadCase")
    graph.add_edge("loadCase", "triage")
    graph.add_conditional_edges(
        "triage", lambda s: "closeEscalated" if _escalated(s) else "diagnose", ["diagnose", "closeEscalated"]
    )

    def after_diagnose(s: dict[str, Any]) -> str:
        if _escalated(s):
            return "closeEscalated"
        return "resolve" if s.get("diagnosis") else "plan"

    graph.add_conditional_edges("diagnose", after_diagnose, ["resolve", "plan", "closeEscalated"])

    def fan_out(s: dict[str, Any]) -> Any:
        if _escalated(s):
            return "closeEscalated"
        plan = s.get("investigationPlan")
        specialists = plan["specialists"] if plan else list(AGENT_NAMES)
        return [Send(SPECIALIST_NODE[name], s) for name in specialists]

    graph.add_conditional_edges("plan", fan_out, ["paymentAgent", "reconciliationAgent", "riskAgent", "closeEscalated"])
    graph.add_edge("paymentAgent", "join")
    graph.add_edge("reconciliationAgent", "join")
    graph.add_edge("riskAgent", "join")
    graph.add_conditional_edges(
        "join", lambda s: "closeEscalated" if _escalated(s) else "groundCheck", ["groundCheck", "closeEscalated"]
    )

    def after_ground_check(s: dict[str, Any]) -> str:
        if _escalated(s):
            return "closeEscalated"
        return "plan" if s.get("gaps") else "resolve"

    graph.add_conditional_edges("groundCheck", after_ground_check, ["plan", "resolve", "closeEscalated"])
    graph.add_conditional_edges(
        "resolve", lambda s: "closeEscalated" if _escalated(s) else "policyGate", ["policyGate", "closeEscalated"]
    )

    def after_policy_gate(s: dict[str, Any]) -> str:
        tier = (s.get("policy") or {}).get("tier")
        if tier == "AUTO":
            return "execute"
        if tier == "BLOCKED":
            return "closeBlocked"
        return "awaitApproval"

    graph.add_conditional_edges("policyGate", after_policy_gate, ["execute", "closeBlocked", "awaitApproval"])

    def after_approval(s: dict[str, Any]) -> str:
        decision = (s.get("approval") or {}).get("decision")
        if decision == "APPROVE":
            return "execute"
        if decision == "REJECT":
            return "closeRejected"
        return "closeEscalated"

    graph.add_conditional_edges("awaitApproval", after_approval, ["execute", "closeRejected", "closeEscalated"])
    # An execution failure already closed and escalated inside `execute`, so there is nothing to validate.
    graph.add_conditional_edges("execute", lambda s: END if _escalated(s) else "validate", ["validate", END])
    graph.add_conditional_edges(
        "validate",
        lambda s: "closeResolved" if (s.get("validation") or {}).get("verdict") == "PASS" else "replan",
        ["closeResolved", "replan"],
    )

    def after_replan(s: dict[str, Any]) -> str:
        if _escalated(s):
            return "closeEscalated"
        return "plan" if s.get("diagnosis") is None else "resolve"

    graph.add_conditional_edges("replan", after_replan, ["closeEscalated", "plan", "resolve"])
    for terminal in ("closeResolved", "closeBlocked", "closeRejected", "closeEscalated"):
        graph.add_edge(terminal, END)

    return graph.compile(checkpointer=checkpointer)
