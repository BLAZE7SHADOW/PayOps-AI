"""Graph nodes (docs/03 §5), ported from packages/agents nodes.ts.

Same names, same order of events, same fallbacks. What differs is where the work runs: tools, the policy
gate, execute, validate and the closes are calls to the TypeScript API (`NodeApiPort`), because they read or
change data. Jev decisions, Gemini calls, grounding, risk scoring and routing run here.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from langgraph.types import interrupt

from .budget import add_budgets, check_budget_guard, zero_budget
from .constants import (
    AGENT_NAMES,
    FAST_MAX_NEEDS_HUMAN,
    FAST_MIN_CONFIDENCE,
    FAST_MIN_CONSISTENT,
    MAX_ATTEMPTS,
    MAX_FOLLOWUP_TOOL_CALLS,
    estimate_call_cost_usd,
)
from .context import build_resolve_context, build_specialist_context, slice_evidence_for_agent
from .grounding import (
    CODE_OVERRIDE_CONFIDENCE,
    apply_grounding_rules,
    apply_structural_grounding,
    build_grounding_request,
    reconcile_diagnosis,
    support_key,
    surviving_findings,
)
from .narratives import narrative_for
from .node_api import NodeApiPort
from .planning import choose_plan_specialists
from .ports import DecisionPort, LlmCallMeta, LlmPort
from .questions import choice, noul, score
from .risk import (
    RISK_SCORE_CRITERIA,
    bucket_risk_signals,
    combine_risk_scores,
    extract_risk_signals,
    rules_only_risk_tier,
)
from .runids import next_evidence_id, next_finding_id
from .schemas import DiagnosisSchema, FindingsSchema, build_follow_up_choice_schema
from .tools_catalog import (
    BASELINE_TOOLS,
    FOLLOWUP_TOOLS,
    PAYMENT_FOLLOWUP_TOOLS,
    PAYMENT_TOOLS,
    RECONCILIATION_FOLLOWUP_TOOLS,
    RECONCILIATION_TOOLS,
    RISK_TOOLS,
    ToolDef,
)

State = dict[str, Any]
Update = dict[str, Any]
Node = Callable[[State], Awaitable[Update]]
EventSink = Callable[[str, str, dict[str, Any]], Awaitable[None]]

ROOT_CAUSE_CRITERIA = {
    "WEBHOOK_PROCESSING_FAILURE": "A webhook for this payment was delivered but our consumer failed to process it (non-2xx response).",
    "WEBHOOK_NOT_DELIVERED": "A webhook for this payment was never delivered at all.",
    "ORDER_STATE_DIVERGED": "The gateway shows one state (e.g. captured) but our order record shows another.",
    "LEDGER_POSTING_MISSING": "The gateway captured the payment but no ledger credit was ever posted for it.",
    "DUPLICATE_CAPTURE": "More than one gateway capture exists for the same order.",
    "REFUND_STATUS_NOT_SYNCED": "The gateway refund status has moved on but our internal refund record still shows the old status.",
    "REFUND_NOT_INITIATED": "The order was cancelled or should be refunded, but no refund has been created yet.",
    "REFUND_FAILED_AT_GATEWAY": "A refund was attempted but the gateway reports it failed.",
    "SETTLEMENT_FEE_MISMATCH": "The settlement batch's fees or net amount do not match what the ledger expects.",
    "SETTLEMENT_LINE_MISSING": "A settlement line the ledger expects for this batch is missing.",
    "SUSPECTED_FRAUD": "The velocity, device or identity signals on this payment look abusive rather than a data-sync issue.",
    "UNKNOWN": "None of the above clearly explains this case from the facts given.",
}

PRIMARY_HYPOTHESIS_CRITERIA = {
    "webhook_or_state_sync": "A webhook was missed, failed or arrived late, so our order/payment state diverged from the gateway.",
    "duplicate_capture": "More than one gateway capture exists for the same order.",
    "refund_lifecycle": "A refund is missing, not yet initiated, stuck out of sync, or failed at the gateway.",
    "settlement_reconciliation": "A settlement batch's fees or net amount do not match what the ledger expects.",
    "fraud_or_abuse": "The velocity, device or identity signals on this payment look abusive rather than a data-sync issue.",
}

REPLAN_STRATEGY_CRITERIA = {
    "retry_same_action": "The same action set should work if tried again -- the failure looks transient rather than a wrong choice.",
    "alternative_action": "A different action set from the catalog would fix this case instead of the one just tried.",
    "reinvestigate": "The diagnosis itself may be wrong; another investigation round is needed before proposing anything else.",
    "escalate_to_human": "This needs a person to review rather than another automatic attempt.",
}


@dataclass
class AgentDeps:
    api: NodeApiPort
    llm: LlmPort
    decision: DecisionPort
    on_event: EventSink


def evidence_from(existing: list[dict[str, Any]], results: list[dict[str, Any]], step_id: str) -> list[dict[str, Any]]:
    """Turns the API's tool results into evidence items with run-scoped ids, in tool order."""
    created: list[dict[str, Any]] = []
    pool = list(existing)
    for result in results:
        for draft in result["drafts"]:
            item = {"id": next_evidence_id(pool), "stepId": step_id, **draft}
            created.append(item)
            pool.append(item)
    return created


def _jev_budget(usage: dict[str, Any]) -> dict[str, Any]:
    tokens_in, tokens_out = usage["input_tokens"], usage["output_tokens"]
    return {
        **zero_budget(),
        "jevCalls": 1,
        "tokensIn": tokens_in,
        "tokensOut": tokens_out,
        "costUsd": estimate_call_cost_usd("jev", tokens_in, tokens_out),
    }


def _decision_state(brief: dict[str, Any]) -> dict[str, Any]:
    return {
        "caseType": brief["type"],
        "detectionRuleIds": brief["detectionRuleIds"],
        "amountBand": brief["amountBand"],
        "mismatchedSystems": brief["mismatchedSystems"],
        "flags": brief["flags"],
    }


def build_nodes(deps: AgentDeps) -> dict[str, Node]:
    api, llm, decision, on_event = deps.api, deps.llm, deps.decision, deps.on_event

    async def guard_budget(node_name: str, state: State, update: Update) -> Update:
        """Pre-`policyGate` budget guard (D049): the call that trips a limit completes, the next is stopped."""
        total = add_budgets(state.get("budget") or zero_budget(), update.get("budget") or zero_budget())
        guard = check_budget_guard(total)
        if not guard.exceeded:
            return update
        await on_event(node_name, "NODE_COMPLETED", {"budgetExceeded": True, "reason": guard.reason, "budget": total})
        return {**update, "status": "ESCALATED", "error": guard.reason}

    async def load_case(state: State) -> Update:
        await on_event("loadCase", "NODE_STARTED", {})
        loaded = await api.case_brief(state["caseId"])
        await on_event("loadCase", "NODE_COMPLETED", {"entityRefs": loaded["entityRefs"]})
        return {"entityRefs": loaded["entityRefs"], "status": "INVESTIGATING"}

    async def triage(state: State) -> Update:
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
        await on_event("diagnose", "NODE_STARTED", {})
        brief = state["case"]
        assert brief is not None
        try:
            result = await decision.ask(
                "J6_DIAGNOSE",
                _decision_state(brief),
                {
                    "root_cause": choice("What is most likely causing this case?", dict(ROOT_CAUSE_CRITERIA)),
                    "evidence_consistent": noul("The facts point to one clear cause."),
                    "needs_human": noul("This case looks unusual or risky and should get a full investigation."),
                },
            )
            await on_event("diagnose", "DECISION_MADE", {"tag": "J6_DIAGNOSE", "answers": result["answers"], "usage": result["usage"]})
            answers = result["answers"]
            confidence = answers["root_cause"]["confidence"]
            needs_human = answers["needs_human"]["noul"]
            fast = (
                confidence >= FAST_MIN_CONFIDENCE
                and needs_human <= FAST_MAX_NEEDS_HUMAN
                and answers["evidence_consistent"]["noul"] > FAST_MIN_CONSISTENT
                and len(narrative_for(answers["root_cause"]["choice"], state.get("evidence", []))["citedIds"]) > 0
            )
            diagnosis = (
                {"rootCause": answers["root_cause"]["choice"], "narrative": "", "confidence": confidence, "supportingFindingIds": [], "path": "FAST"}
                if fast
                else None
            )
            await on_event("diagnose", "NODE_COMPLETED", {"path": "FAST" if fast else "FULL", "rootCause": answers["root_cause"]["choice"], "confidence": confidence})
            return await guard_budget("diagnose", state, {"diagnosis": diagnosis, "budget": _jev_budget(result["usage"])})
        except Exception as err:  # noqa: BLE001 - J6 fallback: take the full investigation path
            await on_event("diagnose", "NODE_COMPLETED", {"path": "FULL", "fallback": True, "error": str(err)})
            return await guard_budget("diagnose", state, {"diagnosis": None, "budget": {**zero_budget(), "jevCalls": 1}})

    async def plan(state: State) -> Update:
        await on_event("plan", "NODE_STARTED", {})
        brief = state["case"]
        assert brief is not None
        gaps = state.get("gaps", [])
        round_ = state.get("investigationRound", 0)

        # A targeted re-round: the gaps already say which specialists to re-run, so Jev is not asked again (D041).
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
                _decision_state(brief),
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
            answers = result["answers"]
            confidence = answers["primary_hypothesis"]["confidence"]
            specialists = choose_plan_specialists(
                brief["amountBand"],
                confidence,
                {
                    "payment": answers["need_payment"]["noul"],
                    "reconciliation": answers["need_reconciliation"]["noul"],
                    "risk": answers["need_risk"]["noul"],
                },
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
                {"investigationPlan": investigation_plan, "investigationRound": round_ + 1, "budget": _jev_budget(result["usage"])},
            )
        except Exception as err:  # noqa: BLE001 - J2 fallback: run every specialist rather than guess
            investigation_plan = {"primaryHypothesis": "UNKNOWN", "specialists": list(AGENT_NAMES), "routedBy": "DEFAULT_ALL", "confidence": 0}
            await on_event(
                "plan", "NODE_COMPLETED",
                {"specialists": investigation_plan["specialists"], "routedBy": "DEFAULT_ALL", "fallback": True, "error": str(err)},
            )
            return await guard_budget(
                "plan", state,
                {"investigationPlan": investigation_plan, "investigationRound": round_ + 1, "budget": {**zero_budget(), "jevCalls": 1}},
            )

    def build_specialist_node(agent_name: str, node_name: str, own_tools: list[ToolDef], follow_up_tools: list[ToolDef]) -> Node:
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
            # A failed Gemini call has no code answer to fall back to, so the specialist contributes nothing.
            try:
                follow_up_context = build_specialist_context(agent_name, "followUp", brief, evidence, own_tools, follow_up_tools)
                choice_result = await llm.invoke_structured(
                    follow_up_schema, follow_up_context.messages, LlmCallMeta(node_name, 0, state.get("scenarioKey"))
                )
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
                findings_result = await llm.invoke_structured(
                    FindingsSchema, findings_context.messages, LlmCallMeta(node_name, 1, state.get("scenarioKey"))
                )
                await on_event(
                    node_name, "LLM_CALLED",
                    {
                        "call": "findings",
                        "usage": {"inputTokens": findings_result.input_tokens, "outputTokens": findings_result.output_tokens},
                        "contextTokenEstimate": findings_context.token_estimate,
                        "contextHash": findings_context.content_hash,
                    },
                )
                valid_ids = {e["id"] for e in own_evidence}
                pool = list(state.get("findings", []))
                findings: list[dict[str, Any]] = []
                for f in findings_result.data.findings:  # type: ignore[attr-defined]
                    evidence_ids = [i for i in f.evidenceIds if i in valid_ids]
                    if not evidence_ids:
                        continue  # structural grounding: a finding must cite this agent's own evidence
                    finding = {
                        "id": next_finding_id(pool), "agent": agent_name, "code": f.code,
                        "statement": f.statement, "evidenceIds": evidence_ids, "confidence": f.confidence,
                    }
                    findings.append(finding)
                    pool.append(finding)
                await on_event(node_name, "FINDING_CREATED", {"findingIds": [f["id"] for f in findings]})
                await on_event(node_name, "NODE_COMPLETED", {"evidenceCount": len(own_evidence), "findingCount": len(findings)})

                tokens_in = choice_result.input_tokens + findings_result.input_tokens
                tokens_out = choice_result.output_tokens + findings_result.output_tokens
                return {
                    "evidence": follow_up_evidence,
                    "findings": findings,
                    "agentsVisited": [agent_name],
                    "budget": {
                        **zero_budget(),
                        "llmCalls": 2,
                        "toolCalls": len(chosen_tools),
                        "tokensIn": tokens_in,
                        "tokensOut": tokens_out,
                        "costUsd": estimate_call_cost_usd("gemini", tokens_in, tokens_out),
                    },
                }
            except Exception as err:  # noqa: BLE001
                await on_event(node_name, "NODE_COMPLETED", {"evidenceCount": len(own_baseline), "findingCount": 0, "fallback": True, "error": str(err)})
                return {"agentsVisited": [agent_name]}

        return specialist_node

    payment_agent = build_specialist_node("payment", "paymentAgent", PAYMENT_TOOLS, PAYMENT_FOLLOWUP_TOOLS)
    reconciliation_agent = build_specialist_node("reconciliation", "reconciliationAgent", RECONCILIATION_TOOLS, RECONCILIATION_FOLLOWUP_TOOLS)

    async def risk_agent(state: State) -> Update:
        await on_event("riskAgent", "NODE_STARTED", {})
        evidence = state.get("evidence", [])
        own_evidence = slice_evidence_for_agent(evidence, RISK_TOOLS)
        if not own_evidence:
            await on_event("riskAgent", "NODE_COMPLETED", {"skipped": True})
            return {"agentsVisited": ["risk"]}

        signals = extract_risk_signals(own_evidence)
        buckets = bucket_risk_signals(signals)
        budget = zero_budget()
        try:
            result = await decision.ask(
                "J3_RISK",
                buckets,
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
            answers = result["answers"]
            names = ["velocity_abuse", "identity_mismatch", "chargeback_pattern", "merchant_exposure"]
            scores = {n: answers[n]["score"] for n in names}
            confidences = [answers[n]["confidence"] for n in names]
            mean_confidence = sum(confidences) / len(confidences)
            risk = combine_risk_scores(scores, mean_confidence)
            await on_event("riskAgent", "DECISION_MADE", {"tag": "J3_RISK", "answers": answers, "usage": result["usage"], "tier": risk["tier"]})
            budget = _jev_budget(result["usage"])

            findings: list[dict[str, Any]] = []
            llm_fallback_ran = False
            if mean_confidence < 0.5:
                llm_fallback_ran = True
                brief = state["case"]
                assert brief is not None
                ctx = build_specialist_context("risk", "findings", brief, evidence, RISK_TOOLS)
                findings_result = await llm.invoke_structured(FindingsSchema, ctx.messages, LlmCallMeta("riskAgent", 0, state.get("scenarioKey")))
                await on_event(
                    "riskAgent", "LLM_CALLED",
                    {
                        "call": "findings",
                        "usage": {"inputTokens": findings_result.input_tokens, "outputTokens": findings_result.output_tokens},
                        "contextTokenEstimate": ctx.token_estimate,
                        "contextHash": ctx.content_hash,
                    },
                )
                valid_ids = {e["id"] for e in own_evidence}
                pool = list(state.get("findings", []))
                for f in findings_result.data.findings:  # type: ignore[attr-defined]
                    evidence_ids = [i for i in f.evidenceIds if i in valid_ids]
                    if not evidence_ids:
                        continue
                    finding = {
                        "id": next_finding_id(pool), "agent": "risk", "code": f.code,
                        "statement": f.statement, "evidenceIds": evidence_ids, "confidence": f.confidence,
                    }
                    findings.append(finding)
                    pool.append(finding)
                if findings:
                    await on_event("riskAgent", "FINDING_CREATED", {"findingIds": [f["id"] for f in findings]})
                budget = {
                    **budget,
                    "llmCalls": 1,
                    "tokensIn": budget["tokensIn"] + findings_result.input_tokens,
                    "tokensOut": budget["tokensOut"] + findings_result.output_tokens,
                    "costUsd": budget["costUsd"] + estimate_call_cost_usd("gemini", findings_result.input_tokens, findings_result.output_tokens),
                }

            await on_event("riskAgent", "NODE_COMPLETED", {"tier": risk["tier"], "meanConfidence": risk["meanConfidence"], "findingCount": len(findings)})
            if llm_fallback_ran:
                return {"risk": risk, "findings": findings, "agentsVisited": ["risk"], "budget": budget}
            return {"risk": risk, "agentsVisited": ["risk"], "budget": budget}
        except Exception as err:  # noqa: BLE001 - J3 fallback: rules-only tier, never leaves state.risk unset
            risk = rules_only_risk_tier(signals)
            await on_event("riskAgent", "NODE_COMPLETED", {"tier": risk["tier"], "fallback": True, "error": str(err)})
            return {"risk": risk, "agentsVisited": ["risk"], "budget": {**zero_budget(), "jevCalls": 1}}

    async def join(state: State) -> Update:
        await on_event("join", "NODE_STARTED", {})
        await on_event(
            "join", "NODE_COMPLETED",
            {
                "agentsVisited": state.get("agentsVisited", []),
                "evidenceCount": len(state.get("evidence", [])),
                "findingCount": len(state.get("findings", [])),
            },
        )
        # The specialists' combined spend is first visible on the merged state here (D049).
        return await guard_budget("join", state, {})

    async def ground_check(state: State) -> Update:
        await on_event("groundCheck", "NODE_STARTED", {})
        findings = state.get("findings", [])
        evidence_by_id = {e["id"]: e for e in state.get("evidence", [])}
        structural = apply_structural_grounding(findings, evidence_by_id)
        jev_state, questions = build_grounding_request(structural["sound"], evidence_by_id)

        def to_grounding(rules: dict[str, Any]) -> dict[str, Any]:
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
            suff = result["answers"].get("sufficient")
            sufficient_noul = suff["noul"] if suff and suff.get("type") == "noul" else 1
            rules = apply_grounding_rules(
                findings, structural["violations"], semantic, sufficient_noul,
                state.get("agentsVisited", []), state.get("investigationRound", 0),
            )
            grounding = to_grounding(rules)
            await on_event("groundCheck", "NODE_COMPLETED", {"violations": grounding["violations"], "sufficient": rules["sufficient"], "gaps": rules["gaps"]})
            return await guard_budget("groundCheck", state, {"grounding": grounding, "gaps": rules["gaps"], "budget": _jev_budget(result["usage"])})
        except Exception as err:  # noqa: BLE001 - J4 fallback: structural check only, human review flagged
            rules = apply_grounding_rules(
                findings, structural["violations"], None, None, state.get("agentsVisited", []), state.get("investigationRound", 0)
            )
            grounding = to_grounding(rules)
            await on_event("groundCheck", "NODE_COMPLETED", {"violations": grounding["violations"], "fallback": True, "error": str(err)})
            return await guard_budget("groundCheck", state, {"grounding": grounding, "gaps": [], "budget": {**zero_budget(), "jevCalls": 1}})

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
        grounded = surviving_findings(state_findings, grounding["violations"] if grounding else None)

        if not diagnosis:
            ctx = build_resolve_context(brief, grounded, len(evidence), state.get("risk"), grounding, state.get("history", []))
            try:
                result = await llm.invoke_structured(DiagnosisSchema, ctx.messages, LlmCallMeta("resolve", 0, state.get("scenarioKey")))
            except Exception as err:  # noqa: BLE001 - no code diagnosis to fall back to: escalate the case (D049)
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
                    "contextTokenEstimate": ctx.token_estimate,
                    "contextHash": ctx.content_hash,
                },
            )
        elif not diagnosis["narrative"]:
            narrative = narrative_for(diagnosis["rootCause"], evidence)
            finding = {
                "id": next_finding_id(state_findings), "agent": "payment", "code": "OTHER", "statement": narrative["text"],
                "evidenceIds": narrative["citedIds"], "confidence": diagnosis["confidence"],
            }
            findings.append(finding)
            diagnosis = {**diagnosis, "narrative": narrative["text"], "supportingFindingIds": [finding["id"]]}
            await on_event("resolve", "FINDING_CREATED", {"findingIds": [finding["id"]]})

        # Code confirms the stated cause against the evidence (D063, D064). The settlement checks read
        # getFeeBreakdown, which the model may not have asked for, so code fetches it rather than treat a
        # missing lookup as "no evidence".
        missing = [t for t in FOLLOWUP_TOOLS if t.name == "getFeeBreakdown" and not any(e["source"] == t.name for e in evidence)]
        top_up_results = await api.run_tools(state["caseId"], [t.name for t in missing]) if missing else []
        top_up = evidence_from(evidence, top_up_results, "resolve")
        checked_evidence = [*evidence, *top_up]
        reconciliation = reconcile_diagnosis(diagnosis["rootCause"], checked_evidence)
        if reconciliation["kind"] == "REPLACE":
            replaced = narrative_for(reconciliation["rootCause"], checked_evidence)
            finding = {
                "id": next_finding_id([*state_findings, *findings]), "agent": "payment", "code": "OTHER",
                "statement": replaced["text"], "evidenceIds": replaced["citedIds"], "confidence": CODE_OVERRIDE_CONFIDENCE,
            }
            findings.append(finding)
            diagnosis = {
                **diagnosis,
                "rootCause": reconciliation["rootCause"],
                "narrative": f"{replaced['text']} Corrected by code: {reconciliation['reason']}",
                "confidence": CODE_OVERRIDE_CONFIDENCE,
                "supportingFindingIds": [finding["id"]],
            }
        elif reconciliation["kind"] == "ESCALATE":
            unknown = narrative_for("UNKNOWN", checked_evidence)
            candidates = reconciliation["candidates"]
            options = (
                f" Causes the evidence supports: {', '.join(candidates)}." if candidates else " The evidence supports no known cause."
            )
            diagnosis = {
                **diagnosis,
                "rootCause": "UNKNOWN",
                "narrative": f"{unknown['text']} {reconciliation['reason']}{options}",
                "supportingFindingIds": [],
            }

        proposal = await api.proposal(state["caseId"], diagnosis, state.get("history", []))
        await on_event("resolve", "PROPOSAL_CREATED", {"diagnosis": diagnosis, "proposal": proposal, "rootCauseCheck": reconciliation})
        await on_event("resolve", "NODE_COMPLETED", {})
        return await guard_budget("resolve", state, {"diagnosis": diagnosis, "proposal": proposal, "findings": findings, "budget": budget, "evidence": top_up})

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
        await on_event("awaitApproval", "NODE_STARTED", {"approvalId": state.get("approvalId")})
        policy = state.get("policy")
        decided = interrupt({"approvalId": state.get("approvalId"), "tier": policy["tier"] if policy else None, "proposal": state.get("proposal")})
        await on_event("awaitApproval", "APPROVAL_RESOLVED", {"decision": decided["decision"]})
        status = "EXECUTING" if decided["decision"] == "APPROVE" else "REJECTED" if decided["decision"] == "REJECT" else "ESCALATED"
        return {"approval": decided, "status": status}

    async def execute(state: State) -> Update:
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
        await on_event("validate", "NODE_STARTED", {"resolutionId": state.get("resolutionId")})
        validation = await api.validate(state["resolutionId"])  # type: ignore[arg-type]
        await on_event("validate", "VALIDATION_COMPLETED", {"validation": validation})
        await on_event("validate", "NODE_COMPLETED", {})
        return {"validation": validation}

    async def close_resolved(state: State) -> Update:
        await on_event("closeResolved", "NODE_STARTED", {})
        await api.close_validated(state["caseId"], state["runId"], state["resolutionId"], "PASS")  # type: ignore[arg-type]
        proposal = state.get("proposal")
        escalates = any(a["type"] == "ESCALATE_TO_HUMAN" for a in (proposal["actions"] if proposal else []))
        status = "ESCALATED" if escalates else "RESOLVED"
        await on_event("closeResolved", "RUN_COMPLETED", {"status": status})
        return {"status": status}

    async def replan(state: State) -> Update:
        await on_event("replan", "NODE_STARTED", {"attempt": state.get("attempt", 1)})
        validation = state["validation"]
        assert validation is not None
        attempt = state.get("attempt", 1)
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
            # Confidence floor (docs/03 §4 J5): code overrides a low-confidence answer.
            strategy = "escalate_to_human" if answer["confidence"] < 0.5 else answer["choice"]
            await on_event("replan", "NODE_COMPLETED", {"strategy": strategy, "confidence": answer["confidence"]})
            if strategy == "escalate_to_human":
                return {"history": [summary], "status": "ESCALATED", "budget": budget}
            await on_event("replan", "RUN_REPLANNING", {"strategy": strategy, "nextAttempt": attempt + 1})
            if strategy == "reinvestigate":
                # A fresh round: clear the stale diagnosis so `resolve` runs the full LLM path again.
                return {"history": [summary], "diagnosis": None, "gaps": [], "investigationRound": 0, "budget": budget}
            return {"history": [summary], "budget": budget}
        except Exception as err:  # noqa: BLE001 - J5 fallback: escalate
            await on_event("replan", "NODE_COMPLETED", {"strategy": "escalate_to_human", "fallback": True, "error": str(err)})
            return {"history": [summary], "status": "ESCALATED", "budget": {**zero_budget(), "jevCalls": 1}}

    async def close_blocked(state: State) -> Update:
        await on_event("close", "RUN_COMPLETED", {"status": "ESCALATED", "reason": "BLOCKED by policy"})
        return {"status": "ESCALATED"}

    async def close_rejected(state: State) -> Update:
        await on_event("close", "RUN_COMPLETED", {"status": "REJECTED"})
        return {"status": "REJECTED"}

    async def close_escalated(state: State) -> Update:
        validation = state.get("validation")
        if validation:
            await api.close_validated(state["caseId"], state["runId"], state["resolutionId"], validation["verdict"])  # type: ignore[arg-type]
        elif not state.get("resolutionId") and state.get("error"):
            await api.escalate_without_proposal(state["caseId"], state["runId"], state["error"])  # type: ignore[arg-type]
        error = state.get("error")
        await on_event("close", "RUN_COMPLETED", {"status": "ESCALATED", **({"reason": error} if error else {})})
        return {"status": "ESCALATED"}

    return {
        "loadCase": load_case,
        "triage": triage,
        "diagnose": diagnose,
        "plan": plan,
        "paymentAgent": payment_agent,
        "reconciliationAgent": reconciliation_agent,
        "riskAgent": risk_agent,
        "join": join,
        "groundCheck": ground_check,
        "resolve": resolve,
        "policyGate": policy_gate,
        "awaitApproval": await_approval,
        "execute": execute,
        "validate": validate,
        "closeResolved": close_resolved,
        "replan": replan,
        "closeBlocked": close_blocked,
        "closeRejected": close_rejected,
        "closeEscalated": close_escalated,
    }
