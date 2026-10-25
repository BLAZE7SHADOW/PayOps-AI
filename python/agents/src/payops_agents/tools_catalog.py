"""The tool catalog (packages/agents tools.ts, docs/03 §9): names, groups and descriptions only.

The tools themselves run in the TypeScript API over a freshly loaded `CaseState` (`/internal/agent/tools`),
because they read the database and the gateway. Python needs the catalog to build prompts (the follow-up
prompt lists each tool's description), to scope a specialist's evidence to its own tools, and to ask for
the right tool names. Descriptions are hashed into REPLAY keys, so they must match tools.ts exactly.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ToolDef:
    name: str
    group: str  # payment | reconciliation | risk
    baseline: bool
    description: str


PAYMENT_TOOLS: list[ToolDef] = [
    ToolDef(
        "getInternalPayment", "payment", True,
        "Our internal payment record for this order: status, amount, which gateway payment it's linked to.",
    ),
    ToolDef(
        "getGatewayPayment", "payment", True,
        "The gateway payment(s) for this order: capture status, amount, method, refunded so far. The gateway is the reference system.",
    ),
    ToolDef("getOrder", "payment", True, "The order: current status and amount."),
    ToolDef(
        "getOrderTimeline", "payment", False,
        "Every status transition the order went through, in order, with the reason recorded for each.",
    ),
    ToolDef(
        "getWebhookDeliveries", "payment", True,
        "Every webhook delivery attempt for this order: event type, final status, HTTP codes seen by our consumer.",
    ),
    ToolDef(
        "getPaymentAttempts", "payment", False,
        "The customer's payment attempts in the 24 hours before capture: outcomes and timing, for velocity signals.",
    ),
]

RECONCILIATION_TOOLS: list[ToolDef] = [
    ToolDef(
        "getLedgerEntries", "reconciliation", True,
        "Ledger journals posted for this payment: direction, account, amount, whether it was reversed.",
    ),
    ToolDef("getRefund", "reconciliation", True, "Our internal refund record(s) for this order, if any: status and amount."),
    ToolDef(
        "getRefundGatewayStatus", "reconciliation", True,
        "What the gateway says about each refund: status and when it was processed.",
    ),
    ToolDef(
        "getSettlementLines", "reconciliation", False,
        "Settlement lines for this batch: gross, fee and net per payment, and the line number.",
    ),
    ToolDef(
        "getFeeBreakdown", "reconciliation", False,
        "The settlement batch's totals against the ledger: expected net, actual net and the difference.",
    ),
]

RISK_TOOLS: list[ToolDef] = [
    ToolDef(
        "getCustomerHistory", "risk", True,
        "The customer's account: how long ago it was created, and any risk flags recorded on it.",
    ),
    ToolDef(
        "getDeviceSignals", "risk", True,
        "Distinct devices and card countries seen on the recent attempts, and whether the device location matches the card country.",
    ),
    ToolDef(
        "getFailedAttempts", "risk", True,
        "How many of the recent payment attempts failed, out of how many total, in the risk window before capture.",
    ),
    ToolDef(
        "getChargebackHistory", "risk", True,
        "Settlement disputes raised against this order's merchant recently. This schema does not yet track chargebacks per customer "
        "(docs/DECISIONS.md), so this is the merchant-level exposure proxy, not the customer's own chargeback history.",
    ),
]

ALL_TOOLS: list[ToolDef] = [*PAYMENT_TOOLS, *RECONCILIATION_TOOLS, *RISK_TOOLS]
BASELINE_TOOLS: list[ToolDef] = [t for t in ALL_TOOLS if t.baseline]
FOLLOWUP_TOOLS: list[ToolDef] = [t for t in ALL_TOOLS if not t.baseline]
PAYMENT_FOLLOWUP_TOOLS: list[ToolDef] = [t for t in PAYMENT_TOOLS if not t.baseline]
RECONCILIATION_FOLLOWUP_TOOLS: list[ToolDef] = [t for t in RECONCILIATION_TOOLS if not t.baseline]
RISK_FOLLOWUP_TOOLS: list[ToolDef] = [t for t in RISK_TOOLS if not t.baseline]
