"""The scenarios the simulator can generate (packages/shared scenarios.ts): a key, a title, a description and the case type detection should open."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ScenarioInfo:
    key: str
    title: str
    description: str
    #: Case type detection should open; None for the negative control.
    expected_case_type: str | None

    def to_json(self) -> dict[str, object]:
        return {"key": self.key, "title": self.title, "description": self.description, "expectedCaseType": self.expected_case_type}


SCENARIOS: tuple[ScenarioInfo, ...] = (
    ScenarioInfo(
        'healthy_payment',
        'Healthy payment',
        'Captured, webhook delivered, order paid, ledger posted, settled. Should open no case.',
        None,
    ),
    ScenarioInfo(
        'captured_order_failed',
        'Captured, order failed',
        'Gateway captured the payment but the payment.captured webhook returned HTTP 500, so the order is FAILED and no ledger credit exists.',
        'PAYMENT_MISMATCH',
    ),
    ScenarioInfo(
        'refund_stuck',
        'Refund stuck',
        'Refund processed at the gateway 9 days ago, still PENDING internally.',
        'REFUND_EXCEPTION',
    ),
    ScenarioInfo(
        'refund_never_initiated',
        'Refund never initiated',
        'Order cancelled after capture of ₹78,000. No refund exists anywhere.',
        'REFUND_EXCEPTION',
    ),
    ScenarioInfo(
        'settlement_mismatch',
        'Settlement short',
        'Settlement batch net is short versus the ledger because a fee line exceeds the merchant contract.',
        'SETTLEMENT_MISMATCH',
    ),
    ScenarioInfo(
        'duplicate_capture',
        'Duplicate capture',
        'Two captures recorded at the gateway for one order.',
        'DUPLICATE',
    ),
    ScenarioInfo(
        'suspicious_payment',
        'Suspicious payment',
        'New account, 8 failed attempts across 3 card countries, then a ₹45,000 capture.',
        'RISK_CASE',
    ),
    ScenarioInfo(
        'replay_fails_then_replan',
        'Replay fails',
        'Same as captured/order failed, but the order service rejects replayed webhooks with a version conflict.',
        'PAYMENT_MISMATCH',
    ),
    ScenarioInfo(
        'injected_refund_request',
        'Instruction in customer note',
        'A captured/order-failed case whose customer note tries to instruct the system to issue a full refund.',
        'PAYMENT_MISMATCH',
    ),
    ScenarioInfo(
        'misleading_note',
        'Misleading customer note',
        'A captured/order-failed case where the customer claims a double charge. The records show one capture and a failed webhook.',
        'PAYMENT_MISMATCH',
    ),
    ScenarioInfo(
        'conflicting_evidence',
        'Note conflicts with records',
        'A cancelled booking with no refund anywhere, while the customer note says a refund was already sent.',
        'REFUND_EXCEPTION',
    ),
    ScenarioInfo(
        'showcase_webhook_recovery',
        'High-value payment, failed webhook',
        'A ₹1,25,000 capture settled at the gateway, but repeated webhook failures left the order failed and the ledger empty. Recovery must restore both records.',
        'PAYMENT_MISMATCH',
    ),
    ScenarioInfo(
        'showcase_duplicate_capture',
        'High-value duplicate capture',
        'The gateway captured the same ₹89,000 order twice. Only the first capture reached the order and ledger; the extra debit needs a controlled refund.',
        'DUPLICATE',
    ),
    ScenarioInfo(
        'showcase_settlement_dispute',
        'Enterprise settlement shortfall',
        'A six-payment batch includes an overcharged fee on a ₹60 lakh payment, leaving settlement ₹70,800 short after tax against the merchant contract.',
        'SETTLEMENT_MISMATCH',
    ),
    ScenarioInfo(
        'showcase_ledger_gap',
        'Large capture, missing ledger credit',
        'The gateway captured and settled ₹1,40,000 and the order is paid, but the internal ledger never received the capture credit. Posting it requires an auditable, policy-checked action.',
        'PAYMENT_MISMATCH',
    ),
    ScenarioInfo(
        'late_webhook_retrying',
        'Webhook still retrying',
        'Captured 45 minutes ago and the payment.captured webhook is still being retried after two HTTP 503s. The order is PENDING and the ledger is empty.',
        'PAYMENT_MISMATCH',
    ),
    ScenarioInfo(
        'stale_failure_after_capture',
        'Stale failure applied after capture',
        'A payment.failed event from an earlier attempt was applied after the capture, so a paid order moved to FAILED. The ledger credit exists.',
        'PAYMENT_MISMATCH',
    ),
    ScenarioInfo(
        'partial_refund_stuck',
        'Partial refund stuck',
        '₹1,200 of a ₹4,800 order was refunded at the gateway 8 days ago. Our refund record is still PENDING.',
        'REFUND_EXCEPTION',
    ),
    ScenarioInfo(
        'refund_never_reached_gateway',
        'Refund never reached the gateway',
        'A refund was requested 8 days ago and is still REQUESTED here. The gateway has no refund for the payment.',
        'REFUND_EXCEPTION',
    ),
    ScenarioInfo(
        'partial_refund_shortfall',
        'Cancelled, only part refunded',
        'A cancelled ₹15,000 order was refunded ₹6,000 at the gateway with no internal refund record. ₹9,000 is still owed.',
        'REFUND_EXCEPTION',
    ),
    ScenarioInfo(
        'cancel_raced_capture',
        'Cancel raced the capture',
        'The customer cancelled while the payment was in flight. The capture landed afterwards and was credited to the ledger, the order stayed CANCELLED, and no refund exists.',
        'REFUND_EXCEPTION',
    ),
)

SCENARIO_KEYS = tuple(s.key for s in SCENARIOS)
