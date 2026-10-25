"""Policy, approval, execution, validation and the replan decision (J5)."""

from __future__ import annotations

from langgraph.types import interrupt

from ..budget import zero_budget
from ..constants import MAX_ATTEMPTS
from ..questions import choice
from .criteria import REPLAN_STRATEGY_CRITERIA
from .shared import Node, NodeContext, State, Update


def build_control_nodes(ctx: NodeContext) -> dict[str, Node]:
    api, decision, on_event = ctx.api, ctx.decision, ctx.on_event

    async def policy_gate(state: State) -> Update:
        await on_event("policyGate", "NODE_STARTED", {})
        proposal = state["proposal"]
        diagnosis = state["diagnosis"]
        assert proposal is not None and diagnosis is not None
        gate = await api.policy_gate(
            state["caseId"], state["runId"], {"actions": proposal["actions"], "rationale": proposal["rationale"]}, diagnosis["confidence"]
        )
        policy = gate["policy"]
        await on_event("policyGate", "POLICY_DECIDED", {"tier": policy["tier"], "reasons": policy["reasons"], "resolutionId": gate["resolutionId"]})
        status = "EXECUTING"
        if policy["tier"] == "BLOCKED":
            status = "ESCALATED"
        elif policy["tier"] in ("OPS", "MANAGER"):
            status = "AWAITING_APPROVAL"
        if gate.get("approvalId"):
            await on_event("policyGate", "APPROVAL_REQUESTED", {"approvalId": gate["approvalId"], "tier": policy["tier"]})
        await on_event("policyGate", "NODE_COMPLETED", {"tier": policy["tier"]})
        return {"policy": policy, "resolutionId": gate["resolutionId"], "approvalId": gate.get("approvalId"), "attempt": gate["attempt"], "status": status}

    async def await_approval(state: State) -> Update:
        """Pauses the run until a person decides; the decision arrives as the resume value."""
        await on_event("awaitApproval", "NODE_STARTED", {"approvalId": state.get("approvalId")})
        policy = state.get("policy")
        decided = interrupt({"approvalId": state.get("approvalId"), "tier": policy["tier"] if policy else None, "proposal": state.get("proposal")})
        await on_event("awaitApproval", "APPROVAL_RESOLVED", {"decision": decided["decision"]})
        status = "EXECUTING" if decided["decision"] == "APPROVE" else "REJECTED" if decided["decision"] == "REJECT" else "ESCALATED"
        return {"approval": decided, "status": status}

    async def execute(state: State) -> Update:
        """Runs the proposal's actions. A failed action closes and escalates inside the API (it never reaches `replan`);
        an error thrown by the executor itself escalates the existing resolution rather than crashing the run."""
        await on_event("execute", "NODE_STARTED", {"resolutionId": state.get("resolutionId")})
        outcome = await api.execute(state["caseId"], state["runId"], state["resolutionId"])  # type: ignore[arg-type]
        if outcome["outcome"] == "ERROR":
            await on_event("execute", "RUN_COMPLETED", {"status": "ESCALATED", "fallback": True, "error": outcome["message"]})
            return {"status": "ESCALATED", "error": outcome["message"]}
        await on_event("execute", "EXECUTION_STEP", {"executions": outcome["steps"]})
        if outcome["outcome"] == "FAILED":
            await on_event("execute", "RUN_COMPLETED", {"status": "ESCALATED"})
            return {"executions": outcome["steps"], "status": "ESCALATED"}
        await on_event("execute", "NODE_COMPLETED", {})
        return {"executions": outcome["steps"]}

    async def validate(state: State) -> Update:
        """Checks the executed resolution against fresh data. Does not close it: `replan` may still decide to."""
        await on_event("validate", "NODE_STARTED", {"resolutionId": state.get("resolutionId")})
        validation = await api.validate(state["resolutionId"])  # type: ignore[arg-type]
        await on_event("validate", "VALIDATION_COMPLETED", {"validation": validation})
        await on_event("validate", "NODE_COMPLETED", {})
        return {"validation": validation}

    async def replan(state: State) -> Update:
        """J5, reached after a PARTIAL or FAIL. Code caps win over Jev and cost no call: the attempt cap and a confidence floor of
        0.5 both mean `escalate_to_human`. `retry_same_action` and `alternative_action` take the same route; only `reinvestigate`
        clears the diagnosis (D047)."""
        attempt = state.get("attempt", 1)
        await on_event("replan", "NODE_STARTED", {"attempt": attempt})
        validation = state["validation"]
        assert validation is not None
        failed_checks = [c["id"] for c in validation["checks"] if not c["pass"]]
        failed_text = ", ".join(failed_checks) if failed_checks else "an invariant"
        validator_notes = f"Validator {validation['verdict']}: {failed_text} failed on attempt {attempt}."
        proposal = state.get("proposal")
        summary = {
            "attempt": attempt, "actions": proposal["actions"] if proposal else [], "failedChecks": failed_checks,
            "validatorNotes": validator_notes, "verdict": validation["verdict"],
        }

        if attempt >= MAX_ATTEMPTS:
            await on_event("replan", "NODE_COMPLETED", {"strategy": "escalate_to_human", "reason": "attempt cap"})
            return {"history": [summary], "status": "ESCALATED"}

        try:
            result = await decision.ask(
                "J5_REPLAN",
                {"attempt": attempt, "failedChecks": failed_checks, "validatorNotes": validator_notes},
                {"strategy": choice("What should happen next, given this attempt failed verification?", dict(REPLAN_STRATEGY_CRITERIA))},
            )
            await on_event("replan", "DECISION_MADE", {"tag": "J5_REPLAN", "answers": result["answers"], "usage": result["usage"]})
            usage = result["usage"]
            budget = {**zero_budget(), "jevCalls": 1, "tokensIn": usage["input_tokens"], "tokensOut": usage["output_tokens"]}
            answer = result["answers"]["strategy"]
            strategy = "escalate_to_human" if answer["confidence"] < 0.5 else answer["choice"]
            await on_event("replan", "NODE_COMPLETED", {"strategy": strategy, "confidence": answer["confidence"]})
            if strategy == "escalate_to_human":
                return {"history": [summary], "status": "ESCALATED", "budget": budget}
            await on_event("replan", "RUN_REPLANNING", {"strategy": strategy, "nextAttempt": attempt + 1})
            if strategy == "reinvestigate":
                return {"history": [summary], "diagnosis": None, "gaps": [], "investigationRound": 0, "budget": budget}
            return {"history": [summary], "budget": budget}
        except Exception as err:  # noqa: BLE001 - J5 fallback: escalate
            await on_event("replan", "NODE_COMPLETED", {"strategy": "escalate_to_human", "fallback": True, "error": str(err)})
            return {"history": [summary], "status": "ESCALATED", "budget": {**zero_budget(), "jevCalls": 1}}

    return {"policyGate": policy_gate, "awaitApproval": await_approval, "execute": execute, "validate": validate, "replan": replan}
