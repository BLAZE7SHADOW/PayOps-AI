"""The raw inbound webhook log (D072): the read side. Receiving, replay and the retry queue come with the jobs."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import and_, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import WebhookEvent
from ..domain.cursor import decode_cursor, encode_cursor, is_record
from ..domain.timeutil import to_iso
from ..dto.api import Page
from ..dto.webhooks import WebhookLogCounts, WebhookLogDetail, WebhookLogItem, WebhookLogListQuery
from ..errors import not_found


def _item(r: WebhookEvent) -> dict[str, object]:
    return dict(
        id=r.id, event=r.event, gw_payment_id=r.gw_payment_id, gw_refund_id=r.gw_refund_id, status=r.status, attempt_count=r.attempt_count,
        last_http_status=r.last_http_status, last_message=r.last_message, next_retry_at=to_iso(r.next_retry_at) if r.next_retry_at else None,
        first_received_at=to_iso(r.first_received_at), updated_at=to_iso(r.updated_at),
    )


def _is_list_cursor(v: object) -> bool:
    return is_record(v) and isinstance(v.get("at"), str) and isinstance(v.get("id"), str)  # type: ignore[union-attr]


class WebhookQueryService:
    async def get(self, session: AsyncSession, id_: str) -> WebhookLogDetail:
        row = await session.get(WebhookEvent, id_)
        if row is None:
            raise not_found("Webhook event", id_)
        return WebhookLogDetail(**_item(row), payload=row.payload, attempts=row.attempts)  # type: ignore[arg-type]

    async def list(self, session: AsyncSession, query: WebhookLogListQuery) -> Page[WebhookLogItem]:
        """Newest activity first, keyset-paginated on (updated_at, id)."""
        conditions: list = []
        if query.status:
            conditions.append(WebhookEvent.status == query.status)
        if query.event:
            conditions.append(WebhookEvent.event == query.event)
        if query.gw_payment_id:
            conditions.append(WebhookEvent.gw_payment_id == query.gw_payment_id)
        cursor = decode_cursor(query.cursor, _is_list_cursor)
        if cursor:
            at = datetime.fromisoformat(cursor["at"])
            conditions.append(or_(WebhookEvent.updated_at < at, and_(WebhookEvent.updated_at == at, WebhookEvent.id < cursor["id"])))
        rows = list(
            (await session.scalars(select(WebhookEvent).where(*conditions).order_by(desc(WebhookEvent.updated_at), desc(WebhookEvent.id)).limit(query.limit + 1))).all()
        )
        page = rows[: query.limit]
        last = page[-1] if page else None
        next_cursor = encode_cursor({"at": to_iso(last.updated_at), "id": last.id}) if len(rows) > query.limit and last else None
        return Page[WebhookLogItem](items=[WebhookLogItem(**_item(r)) for r in page], next_cursor=next_cursor)  # type: ignore[arg-type]

    async def counts(self, session: AsyncSession) -> WebhookLogCounts:
        rows = dict((await session.execute(select(WebhookEvent.status, func.count()).group_by(WebhookEvent.status))).all())
        return WebhookLogCounts(processed=rows.get("PROCESSED", 0), failed=rows.get("FAILED", 0), dead=rows.get("DEAD", 0))
