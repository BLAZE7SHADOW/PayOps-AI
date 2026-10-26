"""Read routes for the audit log, the webhook log, the shift handoff, case notes and saved views."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from ...dto.api import Page
from ...dto.audit import AuditChainStatus, AuditEventItem, AuditListQuery
from ...dto.webhooks import WebhookLogCounts, WebhookLogDetail, WebhookLogItem, WebhookLogListQuery
from ...dto.workflow import HandoffQuery, HandoffSummary, OperatorNoteItem, SavedViewItem
from ..deps import ServicesDep, SessionDep
from ..security import SessionUser, require_permission

router = APIRouter()


@router.get("/audit", dependencies=[Depends(require_permission("audit.view"))])
async def list_audit(query: Annotated[AuditListQuery, Query()], services: ServicesDep, session: SessionDep) -> Page[AuditEventItem]:
    return await services.audit.list(session, query)


@router.get("/audit/verify", dependencies=[Depends(require_permission("audit.verify"))])
async def verify_audit(services: ServicesDep, session: SessionDep, head_seq: Annotated[str | None, Query(alias="headSeq")] = None, head_hash: Annotated[str | None, Query(alias="headHash")] = None) -> AuditChainStatus:
    """Walks the whole hash chain. An optional head (seq and hash) saved from an earlier export or check also detects a cut tail."""
    head = None
    if head_seq is not None and head_hash:
        try:
            seq = int(head_seq)
        except ValueError:
            seq = 0
        if seq > 0:
            head = (seq, head_hash)
    return await services.audit.verify_chain(session, head)


@router.get("/audit/export.csv")
async def export_audit(
    request: Request,
    services: ServicesDep,
    session: SessionDep,
    user: Annotated[SessionUser, Depends(require_permission("audit.verify"))],
    case_id: Annotated[str | None, Query(alias="caseId")] = None,
    entity_id: Annotated[str | None, Query(alias="entityId")] = None,
) -> StreamingResponse:
    """The export is itself audited first, so the file shows who took it."""
    from ...services.audit import AuditInput

    async with session.begin():
        await services.audit.record(
            session,
            AuditInput("USER", user.id, user.name, "audit.exported", "system", "audit-log", f"{user.name} exported the audit log as CSV"),
        )
    return StreamingResponse(
        services.audit.export_csv(session, case_id, entity_id),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="payops-audit-log.csv"'},
    )


@router.get("/webhooks", dependencies=[Depends(require_permission("webhook.view"))])
async def list_webhooks(query: Annotated[WebhookLogListQuery, Query()], services: ServicesDep, session: SessionDep) -> Page[WebhookLogItem]:
    return await services.webhooks.list(session, query)


@router.get("/webhooks/counts", dependencies=[Depends(require_permission("webhook.view"))])
async def webhook_counts(services: ServicesDep, session: SessionDep) -> WebhookLogCounts:
    return await services.webhooks.counts(session)


@router.get("/webhooks/{event_id}", dependencies=[Depends(require_permission("webhook.view"))])
async def get_webhook(event_id: str, services: ServicesDep, session: SessionDep) -> WebhookLogDetail:
    return await services.webhooks.get(session, event_id)


@router.get("/handoff", dependencies=[Depends(require_permission("handoff.view"))])
async def handoff(query: Annotated[HandoffQuery, Query()], services: ServicesDep, session: SessionDep) -> HandoffSummary:
    return await services.handoff.summary(session, query.hours)


@router.get("/views")
async def list_views(user: Annotated[SessionUser, Depends(require_permission("view.manage"))], services: ServicesDep, session: SessionDep) -> Page[SavedViewItem]:
    items = await services.views.list(session, user.id)
    return Page[SavedViewItem](items=items, next_cursor=None, total=len(items))


@router.get("/cases/{case_id}/notes", dependencies=[Depends(require_permission("case.view"))])
async def case_notes(case_id: str, services: ServicesDep, session: SessionDep) -> Page[OperatorNoteItem]:
    items = await services.notes.list(session, case_id)
    return Page[OperatorNoteItem](items=items, next_cursor=None, total=len(items))
