"""Order writes. Every transition is checked against ORDER_TRANSITIONS and the optimistic `version` column: the UPDATE
only matches the version we read, so two writers cannot both win. (packages/core order.service.ts)"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from ...db.models import Order
from ...domain.enums import ORDER_TRANSITIONS
from ...domain.timeutil import to_iso
from ...errors import AppError, not_found
from ...ports import Clock
from ..audit import AuditService, WriteContext, audit_from


@dataclass(frozen=True)
class TransitionOptions:
    #: Timeline actor label, e.g. "webhook-consumer", "executor".
    by: str
    reason: str | None = None
    #: Fail with VERSION_CONFLICT unless the order is still at this version.
    expected_version: int | None = None
    #: Link the order to this internal payment as part of the transition.
    payment_id: str | None = None


def can_transition(from_: str, to: str) -> bool:
    return to in ORDER_TRANSITIONS[from_]


def _version_conflict(order_id: str, expected: int, actual: int | None) -> AppError:
    found = "" if actual is None else f", found {actual}"
    return AppError(
        "VERSION_CONFLICT", f"Order {order_id} changed while we were updating it (expected version {expected}{found})"
    )


class OrderService:
    def __init__(self, clock: Clock, audit: AuditService) -> None:
        self._clock = clock
        self._audit = audit

    async def transition(
        self, session: AsyncSession, order_id: str, to: str, opts: TransitionOptions, ctx: WriteContext
    ) -> Order:
        order = await session.get(Order, order_id)
        if order is None:
            raise not_found("Order", order_id)
        if not can_transition(order.status, to):
            raise AppError("INVALID_TRANSITION", f"Order {order_id} cannot move from {order.status} to {to}")
        if opts.expected_version is not None and opts.expected_version != order.version:
            raise _version_conflict(order_id, opts.expected_version, order.version)
        now = self._clock.now()
        step = {"at": to_iso(now), "from": order.status, "to": to, "by": opts.by, "reason": opts.reason}
        values: dict[str, object] = {
            "status": to,
            "version": order.version + 1,
            "timeline": [*order.timeline, step],
            "updated_at": now,
        }
        if opts.payment_id:
            values["payment_id"] = opts.payment_id
        result = await session.execute(
            update(Order)
            .where(Order.id == order_id, Order.version == order.version)
            .values(**values)
            .returning(Order)
            .execution_options(populate_existing=True)
        )
        updated = result.scalar_one_or_none()
        if updated is None:
            raise _version_conflict(order_id, order.version, None)
        reason = f": {opts.reason}" if opts.reason else ""
        await self._audit.record(
            session,
            audit_from(
                ctx,
                action="order.transitioned",
                entity_type="order",
                entity_id=order_id,
                summary=f"Order {order_id} moved {order.status} to {to} (by {opts.by}){reason}",
                before={"status": order.status, "version": order.version},
                after={"status": to, "version": updated.version, "paymentId": updated.payment_id},
            ),
        )
        return updated
