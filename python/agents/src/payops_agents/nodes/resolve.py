"""`resolve`: diagnose (full path) or write the template narrative (fast path), let code check the cause, build the proposal."""

from __future__ import annotations

from typing import Any

from ..budget import zero_budget
from ..constants import estimate_call_cost_usd
from ..context import build_resolve_context
from ..grounding import CODE_OVERRIDE_CONFIDENCE, reconcile_diagnosis, surviving_findings
from ..narratives import narrative_for
from ..ports import LlmCallMeta
from ..runids import next_finding_id
from ..schemas import DiagnosisSchema
from ..tools_catalog import FOLLOWUP_TOOLS
from .shared import Node, NodeContext, State, Update, evidence_from


def _apply_reconciliation(
    diagnosis: dict[str, Any],
    reconciliation: dict[str, Any],
    evidence: list[dict[str, Any]],
    existing_findings: list[dict[str, Any]],
    out: list[dict[str, Any]],
) -> dict[str, Any]:
    """REPLACE: code substitutes the cause and lowers confidence below the policy threshold, so a person approves.
    ESCALATE: the cause becomes UNKNOWN with the reason and the candidates. A new finding is appended to `out`."""
    if reconciliation["kind"] == "REPLACE":
        replaced = narrative_for(reconciliation["rootCause"], evidence)
        finding = {
            "id": next_finding_id(existing_findings), "agent": "payment", "code": "OTHER",
            "statement": replaced["text"], "evidenceIds": replaced["citedIds"], "confidence": CODE_OVERRIDE_CONFIDENCE,
        }
        out.append(finding)
        return {
            **diagnosis,
            "rootCause": reconciliation["rootCause"],
            "narrative": f"{replaced['text']} Corrected by code: {reconciliation['reason']}",
            "confidence": CODE_OVERRIDE_CONFIDENCE,
            "supportingFindingIds": [finding["id"]],
        }
    if reconciliation["kind"] == "ESCALATE":
        unknown = narrative_for("UNKNOWN", evidence)
        candidates = reconciliation["candidates"]
        options = f" Causes the evidence supports: {', '.join(candidates)}." if candidates else " The evidence supports no known cause."
        return {**diagnosis, "rootCause": "UNKNOWN", "narrative": f"{unknown['text']} {reconciliation['reason']}{options}", "supportingFindingIds": []}
    return diagnosis


def build_resolve_node(ctx: NodeContext) -> dict[str, Node]:
    api, llm, on_event, guard_budget = ctx.api, ctx.llm, ctx.on_event, ctx.guard_budget

    async def resolve(state: State) -> Update:
        await on_event("resolve", "NODE_STARTED", {})
        brief = state["case"]
        assert brief is not None
        evidence = state.get("evidence", [])
        state_findings = state.get("findings", [])
        diagnosis = state.get("diagnosis")
        budget = zero_budget()
        findings: list[dict[str, Any]] = []
        grounding = state.get("grounding")

        if not diagnosis:
            grounded = surviving_findings(state_findings, grounding["violations"] if grounding else None)
            context = build_resolve_context(brief, grounded, len(evidence), state.get("risk"), grounding, state.get("history", []))
            # No diagnosis can be built without the model, and no resolution exists yet, so the case itself is escalated
            # (the same route as a budget-guard trip).
            try:
                result = await llm.invoke_structured(DiagnosisSchema, context.messages, LlmCallMeta("resolve", 0, state.get("scenarioKey")))
            except Exception as err:  # noqa: BLE001
                message = f"Gemini call failed while diagnosing the case: {err}"
                await on_event("resolve", "NODE_COMPLETED", {"fallback": True, "error": message})
                return {"status": "ESCALATED", "error": message}
            diagnosis = {**result.data.model_dump(), "path": "FULL"}
            budget = {
                **zero_budget(),
                "llmCalls": 1,
                "tokensIn": result.input_tokens,
                "tokensOut": result.output_tokens,
                "costUsd": estimate_call_cost_usd("gemini", result.input_tokens, result.output_tokens),
            }
            await on_event(
                "resolve", "LLM_CALLED",
                {
                    "call": "diagnosis",
                    "diagnosis": diagnosis,
                    "usage": {"inputTokens": result.input_tokens, "outputTokens": result.output_tokens},
                    "contextTokenEstimate": context.token_estimate,
                    "contextHash": context.content_hash,
                },
            )
        elif not diagnosis["narrative"]:
            # Fast path: a code template writes the narrative, no model call.
            narrative = narrative_for(diagnosis["rootCause"], evidence)
            finding = {
                "id": next_finding_id(state_findings), "agent": "payment", "code": "OTHER", "statement": narrative["text"],
                "evidenceIds": narrative["citedIds"], "confidence": diagnosis["confidence"],
            }
            findings.append(finding)
            diagnosis = {**diagnosis, "narrative": narrative["text"], "supportingFindingIds": [finding["id"]]}
            await on_event("resolve", "FINDING_CREATED", {"findingIds": [finding["id"]]})

        # Code checks the stated cause against the evidence (D063, D064). The settlement checks need getFeeBreakdown, which
        # the model may not have asked for, so code fetches it rather than read a missing lookup as "no evidence".
        missing = [t for t in FOLLOWUP_TOOLS if t.name == "getFeeBreakdown" and not any(e["source"] == t.name for e in evidence)]
        top_up_results = await api.run_tools(state["caseId"], [t.name for t in missing]) if missing else []
        top_up = evidence_from(evidence, top_up_results, "resolve")
        checked_evidence = [*evidence, *top_up]
        reconciliation = reconcile_diagnosis(diagnosis["rootCause"], checked_evidence)
        diagnosis = _apply_reconciliation(diagnosis, reconciliation, checked_evidence, [*state_findings, *findings], findings)

        proposal = await api.proposal(state["caseId"], diagnosis, state.get("history", []))
        await on_event("resolve", "PROPOSAL_CREATED", {"diagnosis": diagnosis, "proposal": proposal, "rootCauseCheck": reconciliation})
        await on_event("resolve", "NODE_COMPLETED", {})
        return await guard_budget("resolve", state, {"diagnosis": diagnosis, "proposal": proposal, "findings": findings, "budget": budget, "evidence": top_up})

    return {"resolve": resolve}
