"""The three specialists (payment, reconciliation, risk) and the `join` where their parallel branches meet."""

from __future__ import annotations

from typing import Any

from ..budget import zero_budget
from ..constants import MAX_FOLLOWUP_TOOL_CALLS, estimate_call_cost_usd
from ..context import build_specialist_context, slice_evidence_for_agent
from ..ports import LlmCallMeta
from ..questions import score
from ..risk import RISK_SCORE_CRITERIA, bucket_risk_signals, combine_risk_scores, extract_risk_signals, rules_only_risk_tier
from ..schemas import FindingsSchema, build_follow_up_choice_schema
from ..tools_catalog import (
    PAYMENT_FOLLOWUP_TOOLS,
    PAYMENT_TOOLS,
    RECONCILIATION_FOLLOWUP_TOOLS,
    RECONCILIATION_TOOLS,
    RISK_TOOLS,
    ToolDef,
)
from .shared import Node, NodeContext, State, Update, build_findings, evidence_from, failed_jev_budget, jev_budget

RISK_SCORES = ("velocity_abuse", "identity_mismatch", "chargeback_pattern", "merchant_exposure")


def build_specialist_nodes(ctx: NodeContext) -> dict[str, Node]:
    api, llm, decision, on_event, guard_budget = ctx.api, ctx.llm, ctx.decision, ctx.on_event, ctx.guard_budget

    def build_specialist_node(agent_name: str, node_name: str, own_tools: list[ToolDef], follow_up_tools: list[ToolDef]) -> Node:
        """Payment and reconciliation share one shape: ask the model which follow-up tools from its own group it wants (call 1),
        run them, then write findings (call 2). No evidence means both calls are skipped; a failed call means the specialist contributes nothing."""
        follow_up_schema = build_follow_up_choice_schema(follow_up_tools)

        async def specialist_node(state: State) -> Update:
            await on_event(node_name, "NODE_STARTED", {})
            evidence = state.get("evidence", [])
            own_baseline = slice_evidence_for_agent(evidence, own_tools)

            if follow_up_schema is None or len(own_baseline) == 0:
                await on_event(node_name, "NODE_COMPLETED", {"evidenceCount": len(own_baseline), "findingCount": 0, "skipped": True})
                return {"agentsVisited": [agent_name]}

            brief = state["case"]
            assert brief is not None
            scenario_key = state.get("scenarioKey")
            try:
                follow_up_context = build_specialist_context(agent_name, "followUp", brief, evidence, own_tools, follow_up_tools)
                choice_result = await llm.invoke_structured(follow_up_schema, follow_up_context.messages, LlmCallMeta(node_name, 0, scenario_key))
                wanted = [{"tool": f.tool, "reason": f.reason} for f in choice_result.data.followUps][:MAX_FOLLOWUP_TOOL_CALLS]  # type: ignore[attr-defined]
                await on_event(
                    node_name, "LLM_CALLED",
                    {
                        "call": "followUps",
                        "followUps": wanted,
                        "usage": {"inputTokens": choice_result.input_tokens, "outputTokens": choice_result.output_tokens},
                        "contextTokenEstimate": follow_up_context.token_estimate,
                        "contextHash": follow_up_context.content_hash,
                    },
                )

                chosen_tools = [t for t in follow_up_tools if any(w["tool"] == t.name for w in wanted)]
                tool_results = await api.run_tools(state["caseId"], [t.name for t in chosen_tools]) if chosen_tools else []
                follow_up_evidence = evidence_from(evidence, tool_results, node_name)
                if follow_up_evidence:
                    await on_event(node_name, "TOOL_COMPLETED", {"tools": [t.name for t in chosen_tools], "evidenceIds": [e["id"] for e in follow_up_evidence]})
                own_evidence = [*own_baseline, *follow_up_evidence]

                findings_context = build_specialist_context(agent_name, "findings", brief, [*evidence, *follow_up_evidence], own_tools)
                findings_result = await llm.invoke_structured(FindingsSchema, findings_context.messages, LlmCallMeta(node_name, 1, scenario_key))
                await on_event(
                    node_name, "LLM_CALLED",
                    {
                        "call": "findings",
                        "usage": {"inputTokens": findings_result.input_tokens, "outputTokens": findings_result.output_tokens},
                        "contextTokenEstimate": findings_context.token_estimate,
                        "contextHash": findings_context.content_hash,
                    },
                )
                findings = build_findings(findings_result.data.findings, agent_name, {e["id"] for e in own_evidence}, state.get("findings", []))  # type: ignore[attr-defined]
                await on_event(node_name, "FINDING_CREATED", {"findingIds": [f["id"] for f in findings]})
                await on_event(node_name, "NODE_COMPLETED", {"evidenceCount": len(own_evidence), "findingCount": len(findings)})

                tokens_in = choice_result.input_tokens + findings_result.input_tokens
                tokens_out = choice_result.output_tokens + findings_result.output_tokens
                return {
                    "evidence": follow_up_evidence,
                    "findings": findings,
                    "agentsVisited": [agent_name],
                    "budget": {
                        **zero_budget(), "llmCalls": 2, "toolCalls": len(chosen_tools), "tokensIn": tokens_in, "tokensOut": tokens_out,
                        "costUsd": estimate_call_cost_usd("gemini", tokens_in, tokens_out),
                    },
                }
            except Exception as err:  # noqa: BLE001
                await on_event(node_name, "NODE_COMPLETED", {"evidenceCount": len(own_baseline), "findingCount": 0, "fallback": True, "error": str(err)})
                return {"agentsVisited": [agent_name]}

        return specialist_node

    async def risk_agent(state: State) -> Update:
        """J3: code buckets the signals, one Jev call scores them, code combines the scores into a tier. Gemini only writes
        findings when Jev's mean confidence is under 0.5. If Jev fails, a rules-only tier is used, so `state.risk` is always set."""
        await on_event("riskAgent", "NODE_STARTED", {})
        evidence = state.get("evidence", [])
        own_evidence = slice_evidence_for_agent(evidence, RISK_TOOLS)
        if not own_evidence:
            await on_event("riskAgent", "NODE_COMPLETED", {"skipped": True})
            return {"agentsVisited": ["risk"]}

        signals = extract_risk_signals(own_evidence)
        try:
            result = await decision.ask(
                "J3_RISK",
                bucket_risk_signals(signals),
                {
                    "velocity_abuse": score(
                        "How much do the recent attempts, devices and cards look like automated abuse rather than one person paying?",
                        list(RISK_SCORE_CRITERIA["velocity_abuse"]),
                    ),
                    "identity_mismatch": score(
                        "How much does this customer's identity look inconsistent (new account, mismatched device/card location)?",
                        list(RISK_SCORE_CRITERIA["identity_mismatch"]),
                    ),
                    "chargeback_pattern": score(
                        "How much does this customer's recorded risk-flag history suggest a dispute pattern?",
                        list(RISK_SCORE_CRITERIA["chargeback_pattern"]),
                    ),
                    "merchant_exposure": score(
                        "How exposed is this merchant to settlement disputes recently?", list(RISK_SCORE_CRITERIA["merchant_exposure"])
                    ),
                },
            )
            answers: dict[str, Any] = result["answers"]
            mean_confidence = sum(answers[n]["confidence"] for n in RISK_SCORES) / len(RISK_SCORES)
            risk = combine_risk_scores({n: answers[n]["score"] for n in RISK_SCORES}, mean_confidence)
            await on_event("riskAgent", "DECISION_MADE", {"tag": "J3_RISK", "answers": answers, "usage": result["usage"], "tier": risk["tier"]})
            budget = jev_budget(result["usage"])

            findings: list[dict[str, Any]] | None = None
            if mean_confidence < 0.5:
                brief = state["case"]
                assert brief is not None
                context = build_specialist_context("risk", "findings", brief, evidence, RISK_TOOLS)
                findings_result = await llm.invoke_structured(FindingsSchema, context.messages, LlmCallMeta("riskAgent", 0, state.get("scenarioKey")))
                await on_event(
                    "riskAgent", "LLM_CALLED",
                    {
                        "call": "findings",
                        "usage": {"inputTokens": findings_result.input_tokens, "outputTokens": findings_result.output_tokens},
                        "contextTokenEstimate": context.token_estimate,
                        "contextHash": context.content_hash,
                    },
                )
                findings = build_findings(findings_result.data.findings, "risk", {e["id"] for e in own_evidence}, state.get("findings", []))  # type: ignore[attr-defined]
                if findings:
                    await on_event("riskAgent", "FINDING_CREATED", {"findingIds": [f["id"] for f in findings]})
                budget = {
                    **budget,
                    "llmCalls": 1,
                    "tokensIn": budget["tokensIn"] + findings_result.input_tokens,
                    "tokensOut": budget["tokensOut"] + findings_result.output_tokens,
                    "costUsd": budget["costUsd"] + estimate_call_cost_usd("gemini", findings_result.input_tokens, findings_result.output_tokens),
                }

            await on_event("riskAgent", "NODE_COMPLETED", {"tier": risk["tier"], "meanConfidence": risk["meanConfidence"], "findingCount": len(findings or [])})
            # The findings channel is touched only when the Gemini fallback ran, even if it kept none.
            if findings is not None:
                return {"risk": risk, "findings": findings, "agentsVisited": ["risk"], "budget": budget}
            return {"risk": risk, "agentsVisited": ["risk"], "budget": budget}
        except Exception as err:  # noqa: BLE001 - J3 fallback: rules-only tier, never leaves state.risk unset
            risk = rules_only_risk_tier(signals)
            await on_event("riskAgent", "NODE_COMPLETED", {"tier": risk["tier"], "fallback": True, "error": str(err)})
            return {"risk": risk, "agentsVisited": ["risk"], "budget": failed_jev_budget()}

    async def join(state: State) -> Update:
        """The specialists' combined spend first shows on the merged state here, so the budget guard runs here (D049)."""
        await on_event("join", "NODE_STARTED", {})
        await on_event(
            "join", "NODE_COMPLETED",
            {
                "agentsVisited": state.get("agentsVisited", []),
                "evidenceCount": len(state.get("evidence", [])),
                "findingCount": len(state.get("findings", [])),
            },
        )
        return await guard_budget("join", state, {})

    return {
        "paymentAgent": build_specialist_node("payment", "paymentAgent", PAYMENT_TOOLS, PAYMENT_FOLLOWUP_TOOLS),
        "reconciliationAgent": build_specialist_node("reconciliation", "reconciliationAgent", RECONCILIATION_TOOLS, RECONCILIATION_FOLLOWUP_TOOLS),
        "riskAgent": risk_agent,
        "join": join,
    }
