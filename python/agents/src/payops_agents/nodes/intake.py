"""Nodes that read the case and decide the path: loadCase, triage, diagnose (J6), plan (J2)."""

from __future__ import annotations

from typing import Any

from ..budget import zero_budget
from ..constants import AGENT_NAMES, FAST_MAX_NEEDS_HUMAN, FAST_MIN_CONFIDENCE, FAST_MIN_CONSISTENT
from ..narratives import narrative_for
from ..planning import choose_plan_specialists
from ..questions import choice, noul
from ..tools_catalog import BASELINE_TOOLS
from .criteria import PRIMARY_HYPOTHESIS_CRITERIA, ROOT_CAUSE_CRITERIA
from .shared import (
    Node,
    NodeContext,
    State,
    Update,
    decision_state,
    evidence_from,
    failed_jev_budget,
    jev_budget,
)


def build_intake_nodes(ctx: NodeContext) -> dict[str, Node]:
    api, decision, on_event, guard_budget = ctx.api, ctx.decision, ctx.on_event, ctx.guard_budget

    async def load_case(state: State) -> Update:
        await on_event("loadCase", "NODE_STARTED", {})
        loaded = await api.case_brief(state["caseId"])
        await on_event("loadCase", "NODE_COMPLETED", {"entityRefs": loaded["entityRefs"]})
        return {"entityRefs": loaded["entityRefs"], "status": "INVESTIGATING"}

    async def triage(state: State) -> Update:
        """Gathers every baseline tool's evidence up front (D038), so the fast path still has evidence to cite."""
        await on_event("triage", "NODE_STARTED", {})
        brief = (await api.case_brief(state["caseId"]))["brief"]
        results = await api.run_tools(state["caseId"], [t.name for t in BASELINE_TOOLS])
        evidence = evidence_from(state.get("evidence", []), results, "triage")
        await on_event("triage", "TOOL_COMPLETED", {"tools": [t.name for t in BASELINE_TOOLS], "evidenceIds": [e["id"] for e in evidence]})
        await on_event("triage", "NODE_COMPLETED", {"brief": brief})
        return await guard_budget(
            "triage", state, {"case": brief, "evidence": evidence, "budget": {**zero_budget(), "toolCalls": len(BASELINE_TOOLS)}}
        )

    async def diagnose(state: State) -> Update:
        """J6: a confident Jev answer with evidence to cite takes the fast path; anything else goes to the full investigation."""
        await on_event("diagnose", "NODE_STARTED", {})
        brief = state["case"]
        assert brief is not None
        try:
            result = await decision.ask(
                "J6_DIAGNOSE",
                decision_state(brief),
                {
                    "root_cause": choice("What is most likely causing this case?", dict(ROOT_CAUSE_CRITERIA)),
                    "evidence_consistent": noul("The facts point to one clear cause."),
                    "needs_human": noul("This case looks unusual or risky and should get a full investigation."),
                },
            )
            await on_event("diagnose", "DECISION_MADE", {"tag": "J6_DIAGNOSE", "answers": result["answers"], "usage": result["usage"]})
            answers = result["answers"]
            confidence = answers["root_cause"]["confidence"]
            fast = (
                confidence >= FAST_MIN_CONFIDENCE
                and answers["needs_human"]["noul"] <= FAST_MAX_NEEDS_HUMAN
                and answers["evidence_consistent"]["noul"] > FAST_MIN_CONSISTENT
                and len(narrative_for(answers["root_cause"]["choice"], state.get("evidence", []))["citedIds"]) > 0
            )
            diagnosis = (
                {"rootCause": answers["root_cause"]["choice"], "narrative": "", "confidence": confidence, "supportingFindingIds": [], "path": "FAST"}
                if fast
                else None
            )
            await on_event("diagnose", "NODE_COMPLETED", {"path": "FAST" if fast else "FULL", "rootCause": answers["root_cause"]["choice"], "confidence": confidence})
            return await guard_budget("diagnose", state, {"diagnosis": diagnosis, "budget": jev_budget(result["usage"])})
        except Exception as err:  # noqa: BLE001 - J6 fallback: take the full investigation path
            await on_event("diagnose", "NODE_COMPLETED", {"path": "FULL", "fallback": True, "error": str(err)})
            return await guard_budget("diagnose", state, {"diagnosis": None, "budget": failed_jev_budget()})

    async def plan(state: State) -> Update:
        """J2: which specialists the full path needs. A targeted re-round (non-empty gaps) skips Jev and reruns the specialists that own the gaps (D041)."""
        await on_event("plan", "NODE_STARTED", {})
        brief = state["case"]
        assert brief is not None
        gaps = state.get("gaps", [])
        round_ = state.get("investigationRound", 0)

        if gaps:
            specialists = [name for name in AGENT_NAMES if any(g["agent"] == name for g in gaps)]
            prior = state.get("investigationPlan")
            investigation_plan = {
                "primaryHypothesis": prior["primaryHypothesis"] if prior else "UNKNOWN",
                "specialists": specialists,
                "routedBy": "GAP_TARGETED",
                "confidence": prior["confidence"] if prior else 0,
            }
            await on_event("plan", "NODE_COMPLETED", {"specialists": specialists, "routedBy": "GAP_TARGETED", "targeted": True, "gaps": gaps})
            return await guard_budget("plan", state, {"investigationPlan": investigation_plan, "investigationRound": round_ + 1})

        try:
            result = await decision.ask(
                "J2_PLAN",
                decision_state(brief),
                {
                    "primary_hypothesis": choice(
                        "What most likely explains why the systems disagree on this case?", dict(PRIMARY_HYPOTHESIS_CRITERIA)
                    ),
                    "need_payment": noul("Investigating the payment/gateway/webhook trail would materially help diagnose this case."),
                    "need_reconciliation": noul("Investigating the ledger/settlement trail would materially help diagnose this case."),
                    "need_risk": noul("Investigating fraud and risk signals would materially help diagnose this case."),
                },
            )
            await on_event("plan", "DECISION_MADE", {"tag": "J2_PLAN", "answers": result["answers"], "usage": result["usage"]})
            answers: dict[str, Any] = result["answers"]
            confidence = answers["primary_hypothesis"]["confidence"]
            specialists = choose_plan_specialists(
                brief["amountBand"],
                confidence,
                {name: answers[f"need_{name}"]["noul"] for name in AGENT_NAMES},
            )
            investigation_plan = {
                "primaryHypothesis": answers["primary_hypothesis"]["choice"],
                "specialists": specialists,
                "routedBy": "JEV",
                "confidence": confidence,
            }
            await on_event(
                "plan", "NODE_COMPLETED",
                {"specialists": specialists, "routedBy": "JEV", "primaryHypothesis": investigation_plan["primaryHypothesis"]},
            )
            return await guard_budget(
                "plan", state,
                {"investigationPlan": investigation_plan, "investigationRound": round_ + 1, "budget": jev_budget(result["usage"])},
            )
        except Exception as err:  # noqa: BLE001 - J2 fallback: run every specialist rather than guess
            investigation_plan = {"primaryHypothesis": "UNKNOWN", "specialists": list(AGENT_NAMES), "routedBy": "DEFAULT_ALL", "confidence": 0}
            await on_event(
                "plan", "NODE_COMPLETED",
                {"specialists": investigation_plan["specialists"], "routedBy": "DEFAULT_ALL", "fallback": True, "error": str(err)},
            )
            return await guard_budget(
                "plan", state,
                {"investigationPlan": investigation_plan, "investigationRound": round_ + 1, "budget": failed_jev_budget()},
            )

    return {"loadCase": load_case, "triage": triage, "diagnose": diagnose, "plan": plan}
