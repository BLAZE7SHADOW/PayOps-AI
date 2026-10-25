"""J4: structural checks in code, then one batched Jev call on the surviving findings."""

from __future__ import annotations

from typing import Any

from ..grounding import apply_grounding_rules, apply_structural_grounding, build_grounding_request, support_key
from .shared import Node, NodeContext, State, Update, failed_jev_budget, jev_budget


def build_grounding_node(ctx: NodeContext) -> dict[str, Node]:
    decision, on_event, guard_budget = ctx.decision, ctx.on_event, ctx.guard_budget

    async def ground_check(state: State) -> Update:
        """`state.findings` only grows, so a dropped finding is not removed: `grounding.violations` records the drop and `resolve`
        filters by it. If Jev fails, only the structural pass applies, the report asks for human review, and no extra round is requested (D041)."""
        await on_event("groundCheck", "NODE_STARTED", {})
        findings = state.get("findings", [])
        evidence_by_id = {e["id"]: e for e in state.get("evidence", [])}
        structural = apply_structural_grounding(findings, evidence_by_id)
        jev_state, questions = build_grounding_request(structural["sound"], evidence_by_id)

        def report(rules: dict[str, Any]) -> dict[str, Any]:
            return {
                "checked": len(findings),
                "violations": rules["violations"],
                "sufficient": rules["sufficient"],
                "needsHumanReview": rules["needsHumanReview"],
            }

        try:
            result = await decision.ask("J4_GROUND", jev_state, questions)
            await on_event("groundCheck", "DECISION_MADE", {"tag": "J4_GROUND", "answers": result["answers"], "usage": result["usage"]})
            semantic: list[dict[str, Any]] = []
            for f in structural["sound"]:
                answer = result["answers"].get(support_key(f["id"]))
                if answer and answer.get("type") == "choice":
                    semantic.append({"findingId": f["id"], "choice": answer["choice"], "confidence": answer["confidence"]})
                else:
                    semantic.append({"findingId": f["id"], "choice": "not_enough_evidence", "confidence": 0})
            sufficient = result["answers"].get("sufficient")
            rules = apply_grounding_rules(
                findings, structural["violations"], semantic, sufficient["noul"] if sufficient and sufficient.get("type") == "noul" else 1,
                state.get("agentsVisited", []), state.get("investigationRound", 0),
            )
            grounding = report(rules)
            await on_event("groundCheck", "NODE_COMPLETED", {"violations": grounding["violations"], "sufficient": rules["sufficient"], "gaps": rules["gaps"]})
            return await guard_budget("groundCheck", state, {"grounding": grounding, "gaps": rules["gaps"], "budget": jev_budget(result["usage"])})
        except Exception as err:  # noqa: BLE001 - J4 fallback
            rules = apply_grounding_rules(
                findings, structural["violations"], None, None, state.get("agentsVisited", []), state.get("investigationRound", 0)
            )
            grounding = report(rules)
            await on_event("groundCheck", "NODE_COMPLETED", {"violations": grounding["violations"], "fallback": True, "error": str(err)})
            return await guard_budget("groundCheck", state, {"grounding": grounding, "gaps": [], "budget": failed_jev_budget()})

    return {"groundCheck": ground_check}
