from payops_agents.budget import add_budgets, check_budget_guard, zero_budget
from payops_agents.grounding import (
    apply_grounding_rules,
    apply_structural_grounding,
    candidate_leaders,
    reconcile_diagnosis,
)
from payops_agents.narratives import narrative_for
from payops_agents.planning import choose_plan_specialists
from payops_agents.risk import (
    bucket_risk_signals,
    combine_risk_scores,
    extract_risk_signals,
    raise_tier_by_one,
    rules_only_risk_tier,
    tier_for_composite,
)
from payops_agents.runids import next_evidence_id, next_finding_id
from payops_agents.state import merge_by_id


def ev(id_: str, source: str, system: str, **facts: object) -> dict:
    return {
        "id": id_,
        "source": source,
        "system": system,
        "entityRef": f"ref_{id_}",
        "facts": facts,
        "observedAt": "2026-09-28T00:00:00.000Z",
        "stepId": "triage",
    }


def test_ids_continue_from_what_exists() -> None:
    assert next_evidence_id([]) == "ev_01"
    assert next_finding_id([{}, {}]) == "fd_03"


def test_state_reducers() -> None:
    assert merge_by_id([{"id": "a", "v": 1}], [{"id": "a", "v": 2}, {"id": "b"}]) == [{"id": "a", "v": 2}, {"id": "b"}]
    assert add_budgets(None, {"toolCalls": 2})["toolCalls"] == 2
    assert add_budgets({"llmCalls": 1}, {"llmCalls": 2})["llmCalls"] == 3


def test_budget_guard_names_the_limit_that_tripped() -> None:
    assert not check_budget_guard({**zero_budget(), "toolCalls": 60}).exceeded
    tools = check_budget_guard({**zero_budget(), "toolCalls": 61})
    assert tools.exceeded and "61 tool calls" in (tools.reason or "")
    cost = check_budget_guard({**zero_budget(), "costUsd": 0.0512})
    assert cost.exceeded and cost.reason == "Budget guard: this run cost an estimated $0.0512, over the $0.05 limit."


def test_planning_routes_by_need_and_amount_band() -> None:
    needs = {"payment": 0.1, "reconciliation": 0.5, "risk": 0.1}
    assert choose_plan_specialists("LOW", 0.9, needs) == ["payment", "reconciliation"]
    assert choose_plan_specialists("HIGH", 0.9, needs) == ["payment", "reconciliation", "risk"]
    assert choose_plan_specialists("LOW", 0.4, needs) == ["payment", "reconciliation", "risk"]  # unsure: run everyone


def test_risk_tiers_and_confidence_raise() -> None:
    assert (
        tier_for_composite(0.75) == "LOW"
        and tier_for_composite(0.76) == "MEDIUM"
        and tier_for_composite(9) == "CRITICAL"
    )
    assert raise_tier_by_one("CRITICAL") == "CRITICAL"
    scores = {"velocity_abuse": 0, "identity_mismatch": 0, "chargeback_pattern": 0, "merchant_exposure": 0}
    assert combine_risk_scores(scores, 0.9)["tier"] == "LOW"
    assert combine_risk_scores(scores, 0.4)["tier"] == "MEDIUM"


def test_risk_signals_buckets_and_rules_only_fallback() -> None:
    evidence = [
        ev("ev_01", "getCustomerHistory", "RISK", accountAgeDays=0.5, riskFlagsCount=2, riskFlags="a,b"),
        ev("ev_02", "getDeviceSignals", "RISK", deviceCount=3, cardCountriesDistinct=2, ipCardCountryMismatch=True),
        ev("ev_03", "getFailedAttempts", "RISK", failed24h=7, total24h=9),
        ev("ev_04", "getChargebackHistory", "RISK", merchantDisputeCount=1),
    ]
    signals = extract_risk_signals(evidence)
    buckets = bucket_risk_signals(signals)
    assert buckets["account_age"] == "created 12 hours ago"
    assert buckets["failed_attempts_24h_bucket"] == "6-10"
    assert buckets["risk_flags"] == "2 flags"
    assert rules_only_risk_tier(signals)["tier"] == "CRITICAL"
    assert extract_risk_signals([])["accountAgeDays"] == 3650  # no record reads as long-established


def test_structural_grounding_drops_findings_citing_the_wrong_evidence() -> None:
    evidence = {
        "ev_01": ev("ev_01", "getWebhookDeliveries", "WEBHOOK", lastHttpStatus=500, finalStatus="FAILED"),
        "ev_02": ev("ev_02", "getOrder", "ORDER", status="PENDING"),
    }
    findings = [
        {
            "id": "fd_01",
            "agent": "payment",
            "code": "WEBHOOK_HTTP_500",
            "statement": "s",
            "evidenceIds": ["ev_01"],
            "confidence": 0.9,
        },
        {
            "id": "fd_02",
            "agent": "payment",
            "code": "WEBHOOK_HTTP_500",
            "statement": "s",
            "evidenceIds": ["ev_02"],
            "confidence": 0.9,
        },
        {
            "id": "fd_03",
            "agent": "payment",
            "code": "OTHER",
            "statement": "s",
            "evidenceIds": ["ev_99"],
            "confidence": 0.9,
        },
    ]
    result = apply_structural_grounding(findings, evidence)
    assert [f["id"] for f in result["sound"]] == ["fd_01"]
    assert [v["findingId"] for v in result["violations"]] == ["fd_02", "fd_03"]


def test_grounding_rules_drop_contradicted_claims_and_ask_for_one_more_round() -> None:
    findings = [
        {
            "id": "fd_01",
            "agent": "payment",
            "code": "OTHER",
            "statement": "s",
            "evidenceIds": ["ev_01"],
            "confidence": 0.9,
        }
    ]
    answers = [{"findingId": "fd_01", "choice": "contradicted", "confidence": 0.7}]
    first = apply_grounding_rules(findings, [], answers, 0.2, ["payment"], 1)
    assert [v["findingId"] for v in first["violations"]] == ["fd_01"]
    assert first["gaps"] == [{"agent": "payment", "reason": "payment ran but has no findings that survived grounding"}]
    capped = apply_grounding_rules(findings, [], answers, 0.2, ["payment"], 2)
    assert capped["gaps"] == []  # the round cap is spent
    fallback = apply_grounding_rules(findings, [], None, None, ["payment"], 1)
    assert fallback["needsHumanReview"] and fallback["sufficient"] and fallback["gaps"] == []


def test_root_cause_reconciliation() -> None:
    evidence = [
        ev("ev_01", "getWebhookDeliveries", "WEBHOOK", lastHttpStatus=500, finalStatus="FAILED", attempts=3),
        ev("ev_02", "getGatewayPayment", "GATEWAY", status="CAPTURED", amountMinor=100),
        ev("ev_03", "getOrder", "ORDER", status="PENDING"),
    ]
    assert candidate_leaders(evidence) == ["WEBHOOK_PROCESSING_FAILURE"]
    assert reconcile_diagnosis("WEBHOOK_PROCESSING_FAILURE", evidence) == {"kind": "KEEP"}
    downstream = reconcile_diagnosis("LEDGER_POSTING_MISSING", evidence)
    assert downstream["kind"] == "REPLACE" and downstream["rootCause"] == "WEBHOOK_PROCESSING_FAILURE"
    nothing = reconcile_diagnosis("DUPLICATE_CAPTURE", [ev("ev_09", "getOrder", "ORDER", status="PAID")])
    assert nothing["kind"] == "ESCALATE" and nothing["candidates"] == []


def test_narratives_cite_their_evidence() -> None:
    evidence = [ev("ev_01", "getWebhookDeliveries", "WEBHOOK", lastHttpStatus=500, finalStatus="FAILED", attempts=3)]
    out = narrative_for("WEBHOOK_PROCESSING_FAILURE", evidence)
    assert out == {
        "text": "The captured webhook failed with HTTP 500 after 3 attempt(s) [ev_01].",
        "citedIds": ["ev_01"],
    }
    assert narrative_for("UNKNOWN", [])["citedIds"] == []
    assert narrative_for("WEBHOOK_PROCESSING_FAILURE", [])["citedIds"] == []
