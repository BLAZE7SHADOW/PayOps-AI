"""Domain vocabulary shared with the web app (packages/shared enums.ts). Values are the strings stored in the database and sent as JSON."""

from __future__ import annotations

from typing import Final

GW_PAYMENT_STATUS: Final = ("CREATED", "AUTHORIZED", "CAPTURED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED")
GW_REFUND_STATUS: Final = ("PENDING", "PROCESSED", "FAILED")
WEBHOOK_EVENT_TYPES: Final = ("payment.authorized", "payment.captured", "payment.failed", "refund.processed", "refund.failed")
WEBHOOK_DELIVERY_STATUS: Final = ("DELIVERED", "FAILED", "PENDING")

ORDER_STATUS: Final = ("PENDING", "PAID", "FAILED", "CANCELLED", "FULFILLED")
#: Allowed order transitions. Anything else is rejected.
ORDER_TRANSITIONS: Final[dict[str, tuple[str, ...]]] = {
    "PENDING": ("PAID", "FAILED", "CANCELLED"),
    "FAILED": ("PAID", "CANCELLED"),
    "PAID": ("FULFILLED", "CANCELLED"),
    "FULFILLED": (),
    "CANCELLED": (),
}
INTERNAL_PAYMENT_STATUS: Final = ("PENDING", "CAPTURED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED")
REFUND_STATUS: Final = ("REQUESTED", "PENDING", "PROCESSED", "FAILED")

ROLES: Final = ("VIEWER", "OPS", "MANAGER", "ADMIN")
_ROLE_RANK: Final = {"VIEWER": 0, "OPS": 1, "MANAGER": 2, "ADMIN": 3}


def role_at_least(role: str, required: str) -> bool:
    return _ROLE_RANK[role] >= _ROLE_RANK[required]


SYSTEMS: Final = ("GATEWAY", "ORDER", "LEDGER", "WEBHOOK", "SETTLEMENT")
CASE_TYPES: Final = ("PAYMENT_MISMATCH", "REFUND_EXCEPTION", "SETTLEMENT_MISMATCH", "RISK_CASE", "DUPLICATE")
CASE_TYPE_LABEL: Final = {
    "PAYMENT_MISMATCH": "Payment mismatch",
    "REFUND_EXCEPTION": "Refund exception",
    "SETTLEMENT_MISMATCH": "Settlement mismatch",
    "RISK_CASE": "Risk review",
    "DUPLICATE": "Duplicate capture",
}
CASE_DISPLAY_PREFIX: Final = {
    "PAYMENT_MISMATCH": "PAY",
    "REFUND_EXCEPTION": "RFD",
    "SETTLEMENT_MISMATCH": "STL",
    "RISK_CASE": "RSK",
    "DUPLICATE": "DUP",
}

SEVERITIES: Final = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
SEVERITY_RANK: Final = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}

CASE_STATUS: Final = ("OPEN", "INVESTIGATING", "AWAITING_APPROVAL", "EXECUTING", "RESOLVED", "ESCALATED", "REJECTED")
OPEN_CASE_STATUSES: Final = ("OPEN", "INVESTIGATING", "AWAITING_APPROVAL", "EXECUTING", "ESCALATED")

DETECTION_RULES: Final = (
    "D1_CAPTURED_NOT_PAID",
    "D2_PAID_NOT_CAPTURED",
    "D3_LEDGER_MISSING",
    "D4_DUPLICATE_CAPTURE",
    "D5_REFUND_PENDING_SLA",
    "D6_REFUND_MISSING",
    "D7_SETTLEMENT_DIFF",
    "D8_RISK_VELOCITY",
)
DETECTION_RULE_LABEL: Final = {
    "D1_CAPTURED_NOT_PAID": "Captured at gateway, order not paid",
    "D2_PAID_NOT_CAPTURED": "Order paid, gateway not captured",
    "D3_LEDGER_MISSING": "Captured payment has no ledger credit",
    "D4_DUPLICATE_CAPTURE": "More than one capture for an order",
    "D5_REFUND_PENDING_SLA": "Refund pending beyond SLA",
    "D6_REFUND_MISSING": "Cancelled order with captured payment and no refund",
    "D7_SETTLEMENT_DIFF": "Settlement net differs from ledger",
    "D8_RISK_VELOCITY": "High-value capture after repeated failures",
}
ACTOR_TYPES: Final = ("USER", "AGENT", "SYSTEM")
