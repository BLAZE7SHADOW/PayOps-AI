"""Evidence grounding (docs/03 §4 J4, §7): structural predicates, J4 rules, root-cause checks and candidates.

Ported from packages/agents grounding.ts and grounding/{predicates,root-cause-checks,candidates}.ts. All pure:
they read evidence dicts and return decisions, with no model and no I/O.
"""

from __future__ import annotations

from typing import Any

from .constants import AGENT_NAMES
from .questions import choice, noul
from .text import scrub_pii_text

Evidence = dict[str, Any]
Finding = dict[str, Any]

MAX_INVESTIGATION_ROUNDS = 2
SUFFICIENCY_THRESHOLD = 0.5
SEMANTIC_DROP_THRESHOLD = 0.5
CODE_OVERRIDE_CONFIDENCE = 0.5

SUPPORT_CRITERIA = {
    "supported": "The cited evidence clearly supports this claim.",
    "contradicted": "The cited evidence contradicts or is inconsistent with this claim.",
    "not_enough_evidence": "The cited evidence does not go far enough to say either way.",
}


# ── fact helpers ─────────────────────────────────────────────────────────────


def _by_system(cited: list[Evidence], system: str) -> list[Evidence]:
    return [e for e in cited if e["system"] == system]


def _by_source(cited: list[Evidence], source: str) -> list[Evidence]:
    return [e for e in cited if e["source"] == source]


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _num_or_none(e: Evidence, key: str) -> float | None:
    v = e["facts"].get(key)
    return v if _is_number(v) else None


def _num(e: Evidence, key: str) -> float:
    v = _num_or_none(e, key)
    return v if v is not None else 0


def _str(e: Evidence, key: str) -> str | None:
    v = e["facts"].get(key)
    return v if isinstance(v, str) else None


# ── structural predicates (one per FindingCode) ──────────────────────────────


def _ledger_credit_missing(cited: list[Evidence]) -> bool:
    trigger = any(_str(e, "status") == "CAPTURED" for e in _by_system(cited, "GATEWAY")) or any(
        _str(e, "status") in ("PAID", "FULFILLED") for e in _by_system(cited, "ORDER")
    )
    return trigger and not any(_str(e, "direction") == "CREDIT" for e in _by_system(cited, "LEDGER"))


def _duplicate_capture(cited: list[Evidence]) -> bool:
    captured = [e for e in _by_system(cited, "GATEWAY") if _str(e, "status") == "CAPTURED"]
    return len({e["entityRef"] for e in captured}) >= 2


def _refund_status_mismatch(cited: list[Evidence]) -> bool:
    internal = next(iter(_by_source(cited, "getRefund")), None)
    gateway = next(iter(_by_source(cited, "getRefundGatewayStatus")), None)
    if internal is None or gateway is None:
        return False
    return _str(internal, "status") != _str(gateway, "status")


FINDING_PREDICATES: dict[str, Any] = {
    "WEBHOOK_HTTP_500": lambda cited: any((_num_or_none(e, "lastHttpStatus") or 0) >= 500 for e in _by_system(cited, "WEBHOOK")),
    "WEBHOOK_UNDELIVERED": lambda cited: any(_str(e, "finalStatus") != "DELIVERED" for e in _by_system(cited, "WEBHOOK")),
    "ORDER_STATE_DIVERGED": lambda cited: len(_by_system(cited, "GATEWAY")) > 0 and len(_by_system(cited, "ORDER")) > 0,
    "LEDGER_CREDIT_MISSING": _ledger_credit_missing,
    "DUPLICATE_CAPTURE_DETECTED": _duplicate_capture,
    "REFUND_STATUS_MISMATCH": _refund_status_mismatch,
    "REFUND_MISSING": lambda cited: any(_str(e, "status") == "CANCELLED" for e in _by_system(cited, "ORDER"))
    and len(_by_system(cited, "REFUND")) == 0,
    "REFUND_FAILED": lambda cited: any(_str(e, "status") == "FAILED" for e in _by_system(cited, "REFUND")),
    "SETTLEMENT_FEE_DIFF": lambda cited: any(
        e["facts"].get("matched") is not True or (_num_or_none(e, "diffMinor") or 0) != 0 for e in _by_system(cited, "SETTLEMENT")
    ),
    "SETTLEMENT_LINE_MISSING": lambda cited: len(_by_source(cited, "getFeeBreakdown")) > 0
    and len(_by_source(cited, "getSettlementLines")) == 0,
    "RISK_SIGNAL": lambda cited: len(_by_system(cited, "RISK")) > 0,
    "OTHER": lambda cited: True,
}


def apply_structural_grounding(findings: list[Finding], evidence_by_id: dict[str, Evidence]) -> dict[str, Any]:
    violations: list[dict[str, str]] = []
    sound: list[Finding] = []
    for f in findings:
        cited: list[Evidence] = []
        all_exist = True
        for eid in f["evidenceIds"]:
            item = evidence_by_id.get(eid)
            if item is None:
                all_exist = False
                break
            cited.append(item)
        if not all_exist:
            violations.append({"findingId": f["id"], "reason": "cites an evidence id that does not exist"})
            continue
        if not FINDING_PREDICATES[f["code"]](cited):
            violations.append({"findingId": f["id"], "reason": f"cited evidence does not satisfy the {f['code']} predicate"})
            continue
        sound.append(f)
    return {"violations": violations, "sound": sound}


# ── J4: the batched Jev request and the rules that act on its answers ────────


def support_key(finding_id: str) -> str:
    return f"support_{finding_id}"


def _scrub_facts(facts: dict[str, Any]) -> dict[str, Any]:
    return {k: scrub_pii_text(v) if isinstance(v, str) else v for k, v in facts.items()}


def build_grounding_request(findings: list[Finding], evidence_by_id: dict[str, Evidence]) -> tuple[dict[str, Any], dict[str, Any]]:
    claims = [
        {
            "id": f["id"],
            "claim": scrub_pii_text(f["statement"]),
            "cited_evidence": [_scrub_facts(evidence_by_id[eid]["facts"] if eid in evidence_by_id else {}) for eid in f["evidenceIds"]],
        }
        for f in findings
    ]
    questions: dict[str, Any] = {}
    for f in findings:
        questions[support_key(f["id"])] = choice(f'Is the claim "{f["id"]}" supported by its cited evidence?', dict(SUPPORT_CRITERIA))
    questions["sufficient"] = noul("The evidence gathered so far is enough to determine why the systems disagree in this case.")
    return {"claims": claims}, questions


def compute_gaps(agents_visited: list[str], surviving: list[Finding]) -> list[dict[str, str]]:
    visited = {a for a in agents_visited if a in AGENT_NAMES}
    with_findings = {f["agent"] for f in surviving}
    return [
        {"agent": agent, "reason": f"{agent} ran but has no findings that survived grounding"}
        for agent in AGENT_NAMES
        if agent in visited and agent not in with_findings
    ]


def apply_grounding_rules(
    findings: list[Finding],
    structural_violations: list[dict[str, str]],
    semantic_answers: list[dict[str, Any]] | None,
    sufficient_noul: float | None,
    agents_visited: list[str],
    investigation_round: int,
) -> dict[str, Any]:
    violations = list(structural_violations)
    if semantic_answers is not None:
        for answer in semantic_answers:
            if answer["choice"] == "contradicted" and answer["confidence"] >= SEMANTIC_DROP_THRESHOLD:
                violations.append({"findingId": answer["findingId"], "reason": "Jev J4 marked this claim contradicted by its cited evidence"})
    dropped = {v["findingId"] for v in violations}
    surviving = [f for f in findings if f["id"] not in dropped]
    needs_human_review = semantic_answers is None
    sufficient = True if needs_human_review else (1 if sufficient_noul is None else sufficient_noul) >= SUFFICIENCY_THRESHOLD
    can_take_extra_round = (not needs_human_review) and (not sufficient) and investigation_round < MAX_INVESTIGATION_ROUNDS
    gaps = compute_gaps(agents_visited, surviving) if can_take_extra_round else []
    return {
        "violations": violations,
        "survivingFindings": surviving,
        "sufficient": sufficient,
        "needsHumanReview": needs_human_review,
        "gaps": gaps,
    }


def surviving_findings(findings: list[Finding], violations: list[dict[str, str]] | None) -> list[Finding]:
    if not violations:
        return list(findings)
    dropped = {v["findingId"] for v in violations}
    return [f for f in findings if f["id"] not in dropped]


# ── root-cause checks and candidates (D063, D064) ────────────────────────────

Check = tuple[bool, str | None]
_OK: Check = (True, None)


def _fail(reason: str) -> Check:
    return (False, reason)


def _from(ev: list[Evidence], source: str) -> list[Evidence]:
    return [e for e in ev if e["source"] == source]


def _captured_gateway(ev: list[Evidence]) -> list[Evidence]:
    return [e for e in _from(ev, "getGatewayPayment") if _str(e, "status") == "CAPTURED"]


def _settlement_differs(ev: list[Evidence]) -> Check:
    return _OK if any(_num(e, "diffMinor") != 0 for e in _from(ev, "getFeeBreakdown")) else _fail(
        "The settlement batch net matches what the ledger expects."
    )


def _webhook_processing_failure(ev: list[Evidence]) -> Check:
    return _OK if any(_num(e, "lastHttpStatus") >= 400 for e in _from(ev, "getWebhookDeliveries")) else _fail(
        "No webhook delivery shows an error response from our consumer."
    )


def _webhook_not_delivered(ev: list[Evidence]) -> Check:
    ok = any(_str(e, "finalStatus") != "DELIVERED" and _num(e, "lastHttpStatus") < 400 for e in _from(ev, "getWebhookDeliveries"))
    return _OK if ok else _fail(
        "No undelivered webhook without an error response was found; a consumer error would be a processing failure."
    )


def _order_state_diverged(ev: list[Evidence]) -> Check:
    if not _captured_gateway(ev):
        return _fail("The gateway does not show a captured payment to compare against.")
    order_behind = any((_str(e, "status") or "") in ("PENDING", "FAILED") for e in _from(ev, "getOrder"))
    payment_behind = any(_str(e, "status") != "CAPTURED" for e in _from(ev, "getInternalPayment"))
    return _OK if order_behind or payment_behind else _fail("Our order and payment records already match the captured gateway payment.")


def _ledger_posting_missing(ev: list[Evidence]) -> Check:
    if not _captured_gateway(ev):
        return _fail("There is no captured gateway payment that should have a ledger credit.")
    if any(e["system"] == "LEDGER" and _str(e, "direction") == "CREDIT" for e in ev):
        return _fail("A ledger credit exists for this payment.")
    return _OK


def _duplicate_capture_check(ev: list[Evidence]) -> Check:
    return _OK if len({e["entityRef"] for e in _captured_gateway(ev)}) >= 2 else _fail(
        "Fewer than two distinct captured gateway payments were found."
    )


def _refund_status_not_synced(ev: list[Evidence]) -> Check:
    internal = next(iter(_from(ev, "getRefund")), None)
    gateway = next(iter(_from(ev, "getRefundGatewayStatus")), None)
    if internal is None or gateway is None:
        return _fail("Both our refund record and the gateway refund status are needed to show a sync gap.")
    if _str(gateway, "status") == "FAILED":
        return _fail("The gateway refund failed; that is a gateway failure, not a sync gap.")
    return _OK if _str(internal, "status") != _str(gateway, "status") else _fail("Our refund status already matches the gateway.")


def _refund_not_initiated(ev: list[Evidence]) -> Check:
    if not _captured_gateway(ev):
        return _fail("There is no captured payment that would need a refund.")
    if not any(_str(e, "status") == "CANCELLED" for e in _from(ev, "getOrder")):
        return _fail("The order is not cancelled.")
    return _OK if not _from(ev, "getRefund") else _fail("A refund record already exists.")


def _refund_failed_at_gateway(ev: list[Evidence]) -> Check:
    return _OK if any(_str(e, "status") == "FAILED" for e in _from(ev, "getRefundGatewayStatus")) else _fail(
        "The gateway does not report the refund as failed."
    )


def _suspected_fraud(ev: list[Evidence]) -> Check:
    signals = [e for e in ev if e["system"] == "RISK"]
    strong = (
        any(_num(e, "failed24h") >= 3 for e in signals)
        or any(_num(e, "cardCountriesDistinct") >= 3 for e in signals)
        or any(e["facts"].get("ipCardCountryMismatch") is True for e in signals)
        or any(_num(e, "riskFlagsCount") > 0 for e in signals)
    )
    return _OK if strong else _fail("No risk signal is strong enough to support suspected fraud.")


ROOT_CAUSE_CHECKS: dict[str, Any] = {
    "WEBHOOK_PROCESSING_FAILURE": _webhook_processing_failure,
    "WEBHOOK_NOT_DELIVERED": _webhook_not_delivered,
    "ORDER_STATE_DIVERGED": _order_state_diverged,
    "LEDGER_POSTING_MISSING": _ledger_posting_missing,
    "DUPLICATE_CAPTURE": _duplicate_capture_check,
    "REFUND_STATUS_NOT_SYNCED": _refund_status_not_synced,
    "REFUND_NOT_INITIATED": _refund_not_initiated,
    "REFUND_FAILED_AT_GATEWAY": _refund_failed_at_gateway,
    "SETTLEMENT_FEE_MISMATCH": _settlement_differs,
    "SETTLEMENT_LINE_MISSING": _settlement_differs,
    "SUSPECTED_FRAUD": _suspected_fraud,
    "UNKNOWN": lambda ev: _OK,
}


def check_root_cause(root_cause: str, evidence: list[Evidence]) -> Check:
    return ROOT_CAUSE_CHECKS[root_cause](evidence)


CAUSE_CHAINS: list[list[str]] = [
    ["WEBHOOK_PROCESSING_FAILURE", "WEBHOOK_NOT_DELIVERED", "ORDER_STATE_DIVERGED", "LEDGER_POSTING_MISSING"],
    ["DUPLICATE_CAPTURE"],
    ["REFUND_NOT_INITIATED", "REFUND_FAILED_AT_GATEWAY", "REFUND_STATUS_NOT_SYNCED"],
    ["SETTLEMENT_FEE_MISMATCH", "SETTLEMENT_LINE_MISSING"],
    ["SUSPECTED_FRAUD"],
]


def candidate_leaders(evidence: list[Evidence]) -> list[str]:
    leaders: list[str] = []
    for chain in CAUSE_CHAINS:
        leader = next((cause for cause in chain if check_root_cause(cause, evidence)[0]), None)
        if leader:
            leaders.append(leader)
    return leaders


def reconcile_diagnosis(chosen: str, evidence: list[Evidence]) -> dict[str, Any]:
    """KEEP, REPLACE (code substitutes a cause) or ESCALATE (no single supported cause)."""
    if chosen == "UNKNOWN":
        return {"kind": "KEEP"}
    leaders = candidate_leaders(evidence)
    ok, reason = check_root_cause(chosen, evidence)
    if ok:
        chain = next(c for c in CAUSE_CHAINS if chosen in c)
        leader = next((lead for lead in leaders if lead in chain), None)
        if leader is None or leader == chosen:
            return {"kind": "KEEP"}
        return {
            "kind": "REPLACE",
            "rootCause": leader,
            "reason": f"{chosen} is a downstream effect of {leader}, which the evidence also supports.",
        }
    if len(leaders) == 1:
        return {"kind": "REPLACE", "rootCause": leaders[0], "reason": f"The stated cause {chosen} was not confirmed: {reason}"}
    return {"kind": "ESCALATE", "candidates": leaders, "reason": f"The stated cause {chosen} was not confirmed: {reason}"}
