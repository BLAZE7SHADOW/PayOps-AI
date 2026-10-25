"""Vocabulary and limits shared with packages/shared (agents.ts, fast-path.ts, actions.ts).

Copied by hand; the parity run against the TypeScript graph (D085) is what keeps them honest.
"""

from __future__ import annotations

from typing import Final

ROOT_CAUSES: Final = (
    "WEBHOOK_PROCESSING_FAILURE",
    "WEBHOOK_NOT_DELIVERED",
    "ORDER_STATE_DIVERGED",
    "LEDGER_POSTING_MISSING",
    "DUPLICATE_CAPTURE",
    "REFUND_STATUS_NOT_SYNCED",
    "REFUND_NOT_INITIATED",
    "REFUND_FAILED_AT_GATEWAY",
    "SETTLEMENT_FEE_MISMATCH",
    "SETTLEMENT_LINE_MISSING",
    "SUSPECTED_FRAUD",
    "UNKNOWN",
)

FINDING_CODES: Final = (
    "WEBHOOK_HTTP_500",
    "WEBHOOK_UNDELIVERED",
    "ORDER_STATE_DIVERGED",
    "LEDGER_CREDIT_MISSING",
    "DUPLICATE_CAPTURE_DETECTED",
    "REFUND_STATUS_MISMATCH",
    "REFUND_MISSING",
    "REFUND_FAILED",
    "SETTLEMENT_FEE_DIFF",
    "SETTLEMENT_LINE_MISSING",
    "RISK_SIGNAL",
    "OTHER",
)

AGENT_NAMES: Final = ("payment", "reconciliation", "risk")
RISK_TIERS_AGENT: Final = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
REPLAN_STRATEGIES: Final = ("retry_same_action", "alternative_action", "reinvestigate", "escalate_to_human")

ACTION_TYPES: Final = (
    "REPLAY_WEBHOOK_EVENT",
    "MARK_ORDER_PAID",
    "POST_LEDGER_ENTRY",
    "REVERSE_LEDGER_ENTRY",
    "INITIATE_REFUND",
    "SYNC_REFUND_STATUS",
    "RAISE_SETTLEMENT_DISPUTE",
    "HOLD_PAYMENT_FOR_REVIEW",
    "ESCALATE_TO_HUMAN",
)

# fast-path.ts
FAST_MIN_CONFIDENCE: Final = 0.8
FAST_MAX_NEEDS_HUMAN: Final = 0.5
FAST_MIN_CONSISTENT: Final = 0.5

# AGENT_BUDGET_LIMITS in agents.ts
MAX_FOLLOWUP_TOOL_CALLS: Final = 6
RECURSION_LIMIT: Final = 40
MAX_ATTEMPTS: Final = 2
MAX_TOOL_CALLS: Final = 60
MAX_COST_USD: Final = 0.05

# CONTEXT_BUDGET in agents.ts (chars/4 token estimate)
CONTEXT_BUDGET: Final = {"payment": 1800, "reconciliation": 1800, "risk": 1200, "resolve": 2200}

# COST_PER_1K_TOKENS_USD in agents.ts
_COST_PER_1K = {"gemini": (0.000075, 0.0003), "jev": (0.00005, 0.00005)}


def estimate_call_cost_usd(kind: str, tokens_in: int, tokens_out: int) -> float:
    rate_in, rate_out = _COST_PER_1K[kind]
    return (tokens_in / 1000) * rate_in + (tokens_out / 1000) * rate_out
