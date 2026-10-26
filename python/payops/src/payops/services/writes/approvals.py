"""Approval decisions. Enforces the role needed for the tier and four-eyes (whoever proposed a resolution cannot approve it). On APPROVE the resolution
continues through the continuation: a person's proposal executes and validates directly, an agent's resumes its graph thread so its own execute,
validate and close nodes run. (packages/core approval.service.ts)"""

from __future__ import annotations

from dataclasses import replace
from typing import TYPE_CHECKING, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ...db.engine import transaction
from ...db.models import Approval, Case, Resolution
from ...domain.bulk_approve import BulkApprovalBody, BulkApprovalResult, BulkApprovalResultItem, BulkApproveInput, bulk_approve_block_reason
from ...dto.resolution import ApprovalDecisionBody, ApprovalItem
from ...errors import AppError
from ...ports import Clock, EventPublisher
from ...realtime import ROOM_OPS, OpsEvents, room_case
from ..approvals import ApprovalQueryService, actions_summary, cannot_decide_reason, to_approval_item
from ..audit import AuditService, audit_from
from .cases import CaseWriteService
from .resolutions import ResolutionService, user_actor, user_write_context

if TYPE_CHECKING:
    from ...api.security import SessionUser


class AgentResumer(Protocol):
    """Resumes a paused agent run with the person's decision (APPROVE, REJECT or ESCALATE)."""

    async def resume(self, run_id: str, decision: str) -> None: ...


class ApprovalService:
    def __init__(
        self, sessions: async_sessionmaker[AsyncSession], clock: Clock, audit: AuditService, events: EventPublisher, cases: CaseWriteService,
        queries: ApprovalQueryService, resolutions: ResolutionService,
    ) -> None:
        self._sessions = sessions
        self._clock = clock
        self._audit = audit
        self._events = events
        self._cases = cases
        self._queries = queries
        self._resolutions = resolutions
        self.agent_resumer: AgentResumer | None = None

    async def _load(self, s: AsyncSession, approval_id: str) -> tuple[Approval, Case, Resolution]:
        row = (
            await s.execute(
                select(Approval, Case, Resolution)
                .join(Case, Case.id == Approval.case_id)
                .join(Resolution, Resolution.id == Approval.resolution_id)
                .where(Approval.id == approval_id)
                .execution_options(populate_existing=True)
            )
        ).first()
        if row is None:
            from ...errors import not_found

            raise not_found("Approval", approval_id)
        return row[0], row[1], row[2]

    async def decide(self, approval_id: str, body: ApprovalDecisionBody, viewer: SessionUser) -> ApprovalItem:
        async with self._sessions() as s:
            a, c, r = await self._load(s, approval_id)
        reason = cannot_decide_reason(a, r, viewer)
        if reason:
            raise AppError("CONFLICT" if a.status != "PENDING" else "FORBIDDEN", reason)
        write = replace(user_write_context(viewer), case_id=c.id, run_id=r.run_id)

        async with transaction(self._sessions) as s:
            locked = (await s.scalars(select(Approval).where(Approval.id == approval_id).with_for_update().execution_options(populate_existing=True))).one_or_none()
            if locked is None or locked.status != "PENDING":
                raise AppError("CONFLICT", "This approval was already decided.")
            now = self._clock.now()
            status = {"APPROVE": "APPROVED", "REJECT": "REJECTED", "ESCALATE": "ESCALATED"}[body.decision]
            locked.status, locked.decided_by, locked.comment, locked.decided_at = status, user_actor(viewer), body.comment or None, now
            resolution = await s.get(Resolution, r.id, populate_existing=True)
            assert resolution is not None
            resolution.status = {"APPROVE": "EXECUTING", "REJECT": "REJECTED", "ESCALATE": "ESCALATED"}[body.decision]
            resolution.updated_at = now
            await s.flush()
            tail = f": {body.comment}" if body.comment else ""
            await self._audit.record(
                s,
                audit_from(
                    write, action="approval.decided", entity_type="approval", entity_id=approval_id,
                    summary=f"{viewer.name} {status.lower()} {actions_summary(r.actions)} for {c.display_id}{tail}",
                    before={"status": "PENDING"}, after={"status": status, "comment": body.comment or None},
                ),
            )
            case_status = {"APPROVE": "EXECUTING", "REJECT": "OPEN", "ESCALATE": "ESCALATED"}[body.decision]
            await self._cases.set_status(s, c.id, case_status, f"{c.display_id}: approval {status.lower()} by {viewer.name}", write)

        async with self._sessions() as s:
            decided = await self._load(s, approval_id)
        payload = to_approval_item(decided[0], decided[1], decided[2], None).to_json()
        self._events.publish(ROOM_OPS, OpsEvents.APPROVAL_RESOLVED, payload)
        self._events.publish(room_case(c.id), OpsEvents.APPROVAL_RESOLVED, payload)

        resolution_row = decided[2]
        if body.decision == "APPROVE":
            if resolution_row.run_id and self.agent_resumer:
                await self.agent_resumer.resume(resolution_row.run_id, "APPROVE")
            else:
                await self._resolutions.finish(resolution_row.id, write)
        elif resolution_row.run_id and self.agent_resumer:
            await self.agent_resumer.resume(resolution_row.run_id, body.decision)
        async with self._sessions() as s:
            after = await self._load(s, approval_id)
        return to_approval_item(after[0], after[1], after[2], viewer)

    async def bulk_approve(self, body: BulkApprovalBody, viewer: SessionUser) -> BulkApprovalResult:
        """Approves several pending approvals in one call (D069). Each item is checked against `bulk_approve_block_reason` and the usual decide rules, then
        approved through `decide`, so the executor, validator and audit trail are the same as for a single click. One item failing does not stop the others."""
        comment = body.comment or "Bulk approved as low risk"
        items: list[BulkApprovalResultItem] = []
        for approval_id in dict.fromkeys(body.ids):
            display_id: str | None = None
            try:
                async with self._sessions() as s:
                    a, c, r = await self._load(s, approval_id)
                display_id = c.display_id
                item = to_approval_item(a, c, r, viewer)
                blocked = item.cannot_decide_reason or bulk_approve_block_reason(
                    BulkApproveInput(
                        tier=item.tier, risk_tier=item.risk_tier, money_moving_minor=item.money_moving_minor, rule_ids=item.rule_ids,
                        action_types=item.action_types, quarantined=(c.signals or {}).get("quarantined") is True,
                    )
                )
                if blocked:
                    items.append(BulkApprovalResultItem(approval_id=approval_id, display_id=display_id, outcome="SKIPPED", message=blocked))
                    continue
                await self.decide(approval_id, ApprovalDecisionBody(decision="APPROVE", comment=comment), viewer)
                items.append(BulkApprovalResultItem(approval_id=approval_id, display_id=display_id, outcome="APPROVED", message="Approved."))
            except Exception as err:  # noqa: BLE001 - one failing item must not stop the rest
                message = err.message if isinstance(err, AppError) else (str(err) or "Failed.")
                items.append(BulkApprovalResultItem(approval_id=approval_id, display_id=display_id, outcome="FAILED", message=message))
        return BulkApprovalResult(
            approved=sum(i.outcome == "APPROVED" for i in items), skipped=sum(i.outcome == "SKIPPED" for i in items),
            failed=sum(i.outcome == "FAILED" for i in items), items=items,
        )
