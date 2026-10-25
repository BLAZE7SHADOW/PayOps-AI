"""The ways a run ends."""

from __future__ import annotations

from .shared import Node, NodeContext, State, Update


def build_close_nodes(ctx: NodeContext) -> dict[str, Node]:
    api, on_event = ctx.api, ctx.on_event

    async def close_resolved(state: State) -> Update:
        """The validator passed: close the resolution. The run ends ESCALATED if the fix itself was an escalation."""
        await on_event("closeResolved", "NODE_STARTED", {})
        await api.close_validated(state["caseId"], state["runId"], state["resolutionId"], "PASS")  # type: ignore[arg-type]
        proposal = state.get("proposal")
        escalates = any(a["type"] == "ESCALATE_TO_HUMAN" for a in (proposal["actions"] if proposal else []))
        status = "ESCALATED" if escalates else "RESOLVED"
        await on_event("closeResolved", "RUN_COMPLETED", {"status": status})
        return {"status": status}

    async def close_blocked(state: State) -> Update:
        await on_event("close", "RUN_COMPLETED", {"status": "ESCALATED", "reason": "BLOCKED by policy"})
        return {"status": "ESCALATED"}

    async def close_rejected(state: State) -> Update:
        await on_event("close", "RUN_COMPLETED", {"status": "REJECTED"})
        return {"status": "REJECTED"}

    async def close_escalated(state: State) -> Update:
        """After a validated attempt that `replan` gave up on the resolution is still open, so it is closed here. After a
        budget-guard trip before `policyGate` there is no resolution, so only the case is escalated. Other routes already closed everything."""
        validation = state.get("validation")
        if validation:
            await api.close_validated(state["caseId"], state["runId"], state["resolutionId"], validation["verdict"])  # type: ignore[arg-type]
        elif not state.get("resolutionId") and state.get("error"):
            await api.escalate_without_proposal(state["caseId"], state["runId"], state["error"])  # type: ignore[arg-type]
        error = state.get("error")
        await on_event("close", "RUN_COMPLETED", {"status": "ESCALATED", **({"reason": error} if error else {})})
        return {"status": "ESCALATED"}

    return {
        "closeResolved": close_resolved,
        "closeBlocked": close_blocked,
        "closeRejected": close_rejected,
        "closeEscalated": close_escalated,
    }
