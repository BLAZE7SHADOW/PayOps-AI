"""What PayOps needs from a payment gateway, as plain records (packages/core ports/gateway.ts). All amounts are in paise."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol


@dataclass(frozen=True)
class GatewayPayment:
    id: str
    order_ref: str
    merchant_id: str
    amount_minor: int
    status: str
    method: str
    #: `{"last4": ..., "network": ..., "country": ...}` or None.
    card: dict[str, str] | None
    captured_at: datetime | None
    refunded_minor: int
    created_at: datetime


@dataclass(frozen=True)
class GatewayRefund:
    id: str
    gw_payment_id: str
    amount_minor: int
    status: str
    processed_at: datetime | None
    created_at: datetime


@dataclass(frozen=True)
class WebhookAttempt:
    at: str
    http_status: int | None
    latency_ms: int
    error: str | None


@dataclass(frozen=True)
class GatewayWebhookDelivery:
    id: str
    event: str
    gw_payment_id: str
    gw_refund_id: str | None
    attempts: list[WebhookAttempt]
    final_status: str
    created_at: datetime


@dataclass(frozen=True)
class GatewaySettlementLine:
    id: str
    batch_id: str
    merchant_id: str
    gw_payment_id: str
    gross_minor: int
    fee_minor: int
    tax_minor: int
    net_minor: int
    line_no: int
    settled_on: datetime


@dataclass(frozen=True)
class WebhookDeliveryResult:
    """Outcome of one delivery attempt of a webhook event to our consumer."""

    http_status: int | None
    attempt_at: str


@dataclass
class CaptureSummary:
    count: int = 0
    amount_minor: int = 0
    extra: dict[str, Any] = field(default_factory=dict)


class PaymentGateway(Protocol):
    """The calls the simulator (over the gw_* tables) or a real gateway adapter must answer."""

    name: str

    async def get_payments(self, ids: list[str]) -> list[GatewayPayment]: ...
    async def list_payments_by_order(self, order_refs: list[str]) -> list[GatewayPayment]: ...
    async def list_webhook_deliveries(self, gw_payment_ids: list[str]) -> list[GatewayWebhookDelivery]: ...
    async def list_refunds(self, gw_payment_ids: list[str]) -> list[GatewayRefund]: ...
    async def list_settlement_lines(
        self, batch_ids: list[str] | None = None, gw_payment_ids: list[str] | None = None
    ) -> list[GatewaySettlementLine]: ...
    async def summarize_captures(self, start: datetime, end: datetime) -> CaptureSummary: ...
