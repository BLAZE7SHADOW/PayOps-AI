"""The policy table and rules (a port of packages/core policy/policy.test.ts)."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from pydantic import TypeAdapter

from payops.domain.policy import POLICY_RULE_TABLE, PolicyInput, approver_hint, evaluate_policy, risk_tier_from_rules
from payops.dto.actions import CatalogAction
from payops.dto.policy import POLICY_RULE_IDS, POLICY_RULES, POLICY_VERSION
from tests.factories import HOUR_MS, MINUTE_MS, attempt, gw_payment, healthy_snapshot, with_snapshot

_ADAPTER: TypeAdapter[Any] = TypeAdapter(CatalogAction)


def act(type_: str, **params: Any) -> Any:
    return _ADAPTER.validate_python({"type": type_, "params": params})


replay = act("REPLAY_WEBHOOK_EVENT", eventId="evt_1")
mark_paid = act("MARK_ORDER_PAID", orderId="ord_1", paymentId="pay_1")
post_ledger = act("POST_LEDGER_ENTRY", paymentId="pay_1", amountMinor=899_900)
sync = act("SYNC_REFUND_STATUS", refundId="rfd_1")
dispute = act("RAISE_SETTLEMENT_DISPUTE", batchId="stb_1", amountMinor=13_924)
hold = act("HOLD_PAYMENT_FOR_REVIEW", paymentId="pay_1")
escalate = act("ESCALATE_TO_HUMAN", reason="Velocity pattern", to="MANAGER")


def refund(amount_minor: int) -> Any:
    return act("INITIATE_REFUND", gwPaymentId="gwp_1", amountMinor=amount_minor, reason="Order cancelled")


BASE = PolicyInput(
    proposer="USER", actions=[replay], risk_tier="LOW", attempt=1, diagnosis_confidence=None, grounding_violations=0,
    precondition_failures=0, gateway_capture_verified=True,
)

AGENT = dict(proposer="AGENT")

TABLE: list[tuple[str, dict[str, Any], str, list[str]]] = [
    ("captured_order_failed: replay", dict(actions=[replay]), "AUTO", ["P6"]),
    ("refund_stuck: sync", dict(actions=[sync]), "AUTO", ["P6"]),
    ("refund_never_initiated: ₹78,000 refund", dict(actions=[refund(7_800_000)]), "MANAGER", ["P3"]),
    ("settlement_mismatch: dispute", dict(actions=[dispute]), "OPS", ["P9"]),
    ("duplicate_capture: ₹4,999 refund", dict(actions=[refund(499_900)]), "OPS", ["P4"]),
    ("suspicious_payment: hold + escalate, risk HIGH", dict(actions=[hold, escalate], risk_tier="HIGH"), "MANAGER", ["P2", "P10"]),
    ("replay_fails attempt 2: mark paid + post ledger", dict(actions=[mark_paid, post_ledger], attempt=2), "OPS", ["P6", "P7"]),
    ("refund exactly ₹1,000 is AUTO", dict(actions=[refund(1_000_00)]), "AUTO", ["P5"]),
    ("refund ₹1,000.01 is OPS", dict(actions=[refund(1_000_01)]), "OPS", ["P4"]),
    ("refund exactly ₹10,000 is OPS", dict(actions=[refund(10_000_00)]), "OPS", ["P4"]),
    ("refund ₹10,000.01 is MANAGER", dict(actions=[refund(10_000_01)]), "MANAGER", ["P3"]),
    ("small refund with MEDIUM risk falls back to OPS", dict(actions=[refund(500_00)], risk_tier="MEDIUM"), "OPS", ["P11"]),
    ("two refunds are summed", dict(actions=[refund(6_000_00), refund(6_000_00)]), "MANAGER", ["P3"]),
    ("CRITICAL risk + refund is BLOCKED", dict(actions=[refund(500_00)], risk_tier="CRITICAL"), "BLOCKED", ["P1", "P2"]),
    ("CRITICAL risk + hold is MANAGER", dict(actions=[hold], risk_tier="CRITICAL"), "MANAGER", ["P2", "P10"]),
    ("precondition failure is BLOCKED", dict(precondition_failures=1), "BLOCKED", ["P0", "P6"]),
    ("empty proposal is BLOCKED", dict(actions=[]), "BLOCKED", ["P0"]),
    ("grounding violation is BLOCKED", dict(grounding_violations=2), "BLOCKED", ["P0", "P6"]),
    ("state correction without verified capture needs OPS", dict(gateway_capture_verified=False), "OPS", ["P11"]),
    ("hold alone is AUTO at LOW risk", dict(actions=[hold]), "AUTO", ["P10"]),
    ("mixed control and correction has no auto rule", dict(actions=[mark_paid, hold]), "OPS", ["P11"]),
    ("attempt 3 raises AUTO to OPS", dict(attempt=3), "OPS", ["P6", "P7"]),
    ("agent correction with 0.9 confidence is AUTO", dict(**AGENT, diagnosis_confidence=0.9), "AUTO", ["P6"]),
    ("agent correction, propose-only: OPS approves", dict(**AGENT, diagnosis_confidence=0.95, agent_control="PROPOSE_ONLY"), "OPS", ["P6", "P12"]),
    ("agent correction, paused: OPS approves", dict(**AGENT, diagnosis_confidence=0.95, agent_control="PAUSED"), "OPS", ["P6", "P12"]),
    ("agent correction, normal mode: still AUTO", dict(**AGENT, diagnosis_confidence=0.95, agent_control="NORMAL"), "AUTO", ["P6"]),
    ("agent hold and escalate stay AUTO while paused", dict(**AGENT, diagnosis_confidence=0.95, actions=[hold, escalate], agent_control="PAUSED"), "AUTO", ["P10"]),
    ("a person's correction is not held by the agent pause", dict(proposer="USER", agent_control="PAUSED"), "AUTO", ["P6"]),
    ("agent correction with 0.8 confidence needs OPS", dict(**AGENT, diagnosis_confidence=0.8), "OPS", ["P11"]),
    ("agent with 0.5 confidence triggers P8", dict(**AGENT, diagnosis_confidence=0.5), "OPS", ["P8"]),
    ("agent small refund needs 0.9 for AUTO", dict(**AGENT, actions=[refund(500_00)], diagnosis_confidence=0.89), "OPS", ["P11"]),
    ("agent small refund at 0.95 is AUTO", dict(**AGENT, actions=[refund(500_00)], diagnosis_confidence=0.95), "AUTO", ["P5"]),
    ("P8 is skipped for people", dict(proposer="USER", diagnosis_confidence=0.1), "AUTO", ["P6"]),
]


@pytest.mark.parametrize(("name", "overrides", "tier", "rules"), TABLE, ids=[t[0] for t in TABLE])
def test_policy_table(name: str, overrides: dict[str, Any], tier: str, rules: list[str]) -> None:
    decision = evaluate_policy(replace(BASE, **overrides))
    assert decision.tier == tier
    assert [r.rule_id for r in decision.reasons] == rules
    assert decision.version == POLICY_VERSION


def test_reports_money_moved_and_risk_tier() -> None:
    decision = evaluate_policy(replace(BASE, actions=[refund(7_800_000)], risk_tier="MEDIUM"))
    assert (decision.money_moving_minor, decision.risk_tier) == (7_800_000, "MEDIUM")
    assert decision.reasons[0].reason == "Refund of ₹78,000.00 is over ₹10,000.00."
    assert decision.to_json()["moneyMovingMinor"] == 7_800_000


def test_every_rule_in_the_shared_table_is_implemented() -> None:
    assert [rule_id for rule_id, _ in POLICY_RULE_TABLE] == list(POLICY_RULE_IDS)
    assert [r.id for r in POLICY_RULES] == list(POLICY_RULE_IDS)


def test_names_who_can_approve() -> None:
    assert approver_hint("OPS") == "Another OPS user or a manager"
    assert approver_hint("MANAGER") == "A manager"
    assert approver_hint("AUTO") is None


CAPTURED_AT = datetime(2026, 9, 28, 11, 50, tzinfo=UTC)


def with_failures(n: int, amount_minor: int):
    s = healthy_snapshot(amount_minor)
    gw = gw_payment(amount_minor=amount_minor, captured_at=CAPTURED_AT)
    return with_snapshot(s, gateway=[gw], recent_attempts=[attempt(at=CAPTURED_AT - timedelta(minutes=(i + 1) * 5)) for i in range(n)])


def test_risk_is_high_at_five_failures_before_a_capture_of_10000_or_more() -> None:
    assert risk_tier_from_rules(with_failures(5, 10_000_00)) == "HIGH"
    assert risk_tier_from_rules(with_failures(8, 45_000_00)) == "HIGH"


def test_risk_is_medium_at_three_failures_or_five_on_a_smaller_capture() -> None:
    assert risk_tier_from_rules(with_failures(3, 45_000_00)) == "MEDIUM"
    assert risk_tier_from_rules(with_failures(5, 9_999_99)) == "MEDIUM"


def test_risk_is_low_otherwise_and_ignores_failures_outside_the_window() -> None:
    assert risk_tier_from_rules(with_failures(2, 45_000_00)) == "LOW"
    s = with_failures(0, 45_000_00)
    old = [attempt(at=CAPTURED_AT - timedelta(hours=25)) for _ in range(6)]
    assert risk_tier_from_rules(replace(s, recent_attempts=old)) == "LOW"
    assert risk_tier_from_rules(None) == "LOW"
    assert HOUR_MS > MINUTE_MS
