"""Small derived facts the action handlers and the options builder share."""

from __future__ import annotations

from ..snapshot import OrderSnapshot

NO_ORDER = "This case has no order or payment to act on."


def refundable_minor(s: OrderSnapshot, gw_payment_id: str) -> int:
    """What can still be refunded on one gateway payment: captured amount minus what the gateway has refunded, minus
    refunds still pending at the gateway, minus our own refunds not yet sent."""
    gw = next((g for g in s.gateway if g.id == gw_payment_id), None)
    if gw is None:
        return 0
    gateway_pending = sum(
        r.amount_minor for r in s.gw_refunds if r.gw_payment_id == gw_payment_id and r.status == "PENDING"
    )
    internal_unsent = sum(
        r.amount_minor
        for r in s.refunds
        if r.gw_payment_id == gw_payment_id and r.gw_refund_id is None and r.status in ("REQUESTED", "PENDING")
    )
    return max(0, gw.amount_minor - gw.refunded_minor - gateway_pending - internal_unsent)
