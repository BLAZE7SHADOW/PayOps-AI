"""Orchestrates one resolution attempt: preview, propose, (approval), execute, validate, close. People use it and the agent proposes through the same
path with its own confidence and grounding inputs. Every step is a short transaction of its own, so nothing holds a transaction while the gateway (and
through it, our webhook consumer) runs. (packages/core resolution.service.ts)"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from pydantic import TypeAdapter
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ...db.engine import transaction
from ...db.models import Approval, Case, Execution, Resolution, ValidationResult
from ...domain.actions.registry import check_preconditions
from ...domain.gateway import PaymentGateway
from ...domain.ids import new_id
from ...domain.permissions import has_permission
from ...domain.policy.evaluate import approver_hint, evaluate_policy
from ...domain.policy.risk import risk_tier_from_rules
from ...domain.policy.rules import PolicyInput
from ...domain.reconciliation.facts import is_captured
from ...dto.actions import CatalogAction, is_undo_proposal
from ...dto.policy import PolicyDecision, ProposerType
from ...dto.resolution import PolicyPreview, ProposeActionsBody, ResolutionItem
from ...dto.validation import PreconditionFailure
from ...errors import AppError, not_found
from ...infra.snapshots import load_case_state
from ...ports import Clock, EventPublisher
from ...realtime import ROOM_OPS, OpsEvents, room_case
from ..agent_control import read_agent_control_mode
from ..approvals import actions_summary
from ..audit import AuditActor, AuditService, WriteContext, audit_from
from ..cases import CLOSED_CASE_STATUSES, CaseQueryService
from ..resolutions import ResolutionQueryService
from .cases import CaseWriteService
from .executor import ExecutionOutcome, ExecutorService
from .reconciliation import ReconciliationService
from .validator import ValidatorService

if TYPE_CHECKING:
    from ...api.security import SessionUser
    from ...domain.actions.types import CaseState

_ACTION: TypeAdapter[CatalogAction] = TypeAdapter(CatalogAction)
_VALIDATOR_CTX = WriteContext(actor=AuditActor("SYSTEM", "validator", "Validator"))


def user_actor(user: SessionUser) -> dict[str, str]:
    return {"type": "USER", "id": user.id, "name": user.name}


def user_write_context(user: SessionUser, case_id: str | None = None) -> WriteContext:
    return WriteContext(actor=AuditActor("USER", user.id, user.name), case_id=case_id)


def agent_actor(run_id: str) -> dict[str, str]:
    """The agent's actor identity for a run, used on its resolution, audit rows and case updates."""
    return {"type": "AGENT", "id": run_id, "name": "PayOps Agent"}


def agent_write_context(case_id: str, run_id: str) -> WriteContext:
    return WriteContext(actor=AuditActor("AGENT", run_id, "PayOps Agent"), case_id=case_id, run_id=run_id)


@dataclass
class AgentProposalResult:
    resolution: Resolution
    approval_id: str | None
    precondition_failures: list[PreconditionFailure]


def _status_for(tier: str) -> str:
    return "BLOCKED" if tier == "BLOCKED" else "EXECUTING" if tier == "AUTO" else "AWAITING_APPROVAL"


class ResolutionService:
    def __init__(
        self, sessions: async_sessionmaker[AsyncSession], clock: Clock, gateway: PaymentGateway, audit: AuditService, events: EventPublisher,
        cases: CaseWriteService, case_queries: CaseQueryService, reconciliation: ReconciliationService, queries: ResolutionQueryService,
        executor: ExecutorService, validator: ValidatorService,
    ) -> None:
        self._sessions = sessions
        self._clock = clock
        self._gateway = gateway
        self._audit = audit
        self._events = events
        self._cases = cases
        self._case_queries = case_queries
        self._reconciliation = reconciliation
        self._queries = queries
        self._executor = executor
        self._validator = validator
        self._approval_item: Callable[[str], Awaitable[dict[str, Any]]] | None = None

    def use_approval_items(self, load: Callable[[str], Awaitable[dict[str, Any]]]) -> None:
        """Wired by the container: approval.requested carries a full ApprovalItem (shared contract)."""
        self._approval_item = load

    # ── Policy ───────────────────────────────────────────────────────────────
    @staticmethod
    def _evaluate(
        state: CaseState, actions: list[CatalogAction], attempt: int, *, proposer: ProposerType, confidence: float | None = None, violations: int = 0,
        agent_control: str | None = None,
    ) -> tuple[PolicyDecision, list[PreconditionFailure]]:
        failures = check_preconditions(actions, state)
        decision = evaluate_policy(
            PolicyInput(
                proposer=proposer, actions=actions, risk_tier=risk_tier_from_rules(state.order), attempt=attempt, diagnosis_confidence=confidence,
                grounding_violations=violations, precondition_failures=len(failures),
                gateway_capture_verified=is_captured(state.order.primary_gw) if state.order else False, agent_control=agent_control,  # type: ignore[arg-type]
            )
        )
        return decision, failures

    async def _attempts_so_far(self, session: AsyncSession, case_id: str) -> int:
        return (await session.execute(select(func.count()).select_from(Resolution).where(Resolution.case_id == case_id))).scalar_one()

    async def preview(self, case_id: str, actions: list[CatalogAction]) -> PolicyPreview:
        async with self._sessions() as s:
            state = await load_case_state(s, self._gateway, case_id, self._clock.now())
            attempt = await self._attempts_so_far(s, case_id) + 1
        decision, failures = self._evaluate(state, actions, attempt, proposer="USER")
        return PolicyPreview(decision=decision, precondition_failures=failures, approver_hint=approver_hint(decision.tier), attempt=attempt)

    # ── Proposals ────────────────────────────────────────────────────────────
    async def _store(
        self, s: AsyncSession, case: Case, *, run_id: str | None, attempt: int, actions: list[CatalogAction], rationale: str, proposed_by: dict[str, str],
        decision: PolicyDecision,
    ) -> Resolution:
        status = _status_for(decision.tier)
        now = self._clock.now()
        resolution = Resolution(
            id=new_id("resolution"), case_id=case.id, run_id=run_id, attempt=attempt, actions=[a.to_json() for a in actions], rationale=rationale,
            proposed_by=proposed_by, policy=decision.to_json(), status=status, created_at=now, updated_at=now,
        )
        s.add(resolution)
        await s.flush()
        return resolution

    async def propose_from_agent(
        self, case_id: str, run_id: str, actions: list[CatalogAction], rationale: str, *, diagnosis_confidence: float, grounding_violations: int
    ) -> AgentProposalResult:
        """An agent run proposes a resolution (node `policyGate`). Same policy engine and tables as a person's proposal; the caller reads `decision.tier`
        off the result to route to approval, execution or escalation, and never lets a BLOCKED proposal execute."""
        write = agent_write_context(case_id, run_id)
        async with self._sessions() as s:
            state = await load_case_state(s, self._gateway, case_id, self._clock.now())
            # Read the operator's agent switch once for this proposal (D066); policy rule P12 uses it.
            agent_control = await read_agent_control_mode(s)
        async with transaction(self._sessions) as s:
            case = (await s.scalars(select(Case).where(Case.id == case_id).with_for_update().execution_options(populate_existing=True))).one_or_none()
            if case is None:
                raise not_found("Case", case_id)
            if case.status in CLOSED_CASE_STATUSES:
                raise AppError("CONFLICT", f"Case {case.display_id} is {case.status}")
            attempt = await self._attempts_so_far(s, case_id) + 1
            decision, failures = self._evaluate(
                state, actions, attempt, proposer="AGENT", confidence=diagnosis_confidence, violations=grounding_violations, agent_control=agent_control
            )
            resolution = await self._store(
                s, case, run_id=run_id, attempt=attempt, actions=actions, rationale=rationale, proposed_by=agent_actor(run_id), decision=decision,
            )
            reasons = ", ".join(r.rule_id for r in decision.reasons) or "no rule"
            await self._audit.record(
                s,
                audit_from(
                    write, action="resolution.proposed", entity_type="resolution", entity_id=resolution.id,
                    summary=f"Agent run {run_id} proposed attempt {attempt} for {case.display_id}: {actions_summary(resolution.actions)}. Policy {decision.tier} ({reasons})",
                    after={"actions": resolution.actions, "policy": decision.to_json(), "preconditionFailures": [f.to_json() for f in failures]},
                ),
            )
            approval_id: str | None = None
            if decision.tier in ("OPS", "MANAGER"):
                approval_id = await self._request_approval(
                    s, case, resolution, decision.tier, agent_actor(run_id), write,
                    f"Agent run {run_id} needs {'a manager' if decision.tier == 'MANAGER' else 'an OPS user'} to approve {case.display_id}: {actions_summary(resolution.actions)}",
                )
            elif decision.tier == "AUTO":
                await self._cases.set_status(s, case_id, "EXECUTING", f"{case.display_id} is executing an AUTO-tier resolution", write)
            else:
                await self._cases.set_status(s, case_id, "ESCALATED", f"{case.display_id}: agent proposal blocked by policy, escalated to a person", write)
        await self._publish(resolution.id, case_id)
        if approval_id:
            await self._announce_approval(approval_id, case_id)
        return AgentProposalResult(resolution, approval_id, failures)

    async def propose(self, case_id: str, body: ProposeActionsBody, viewer: SessionUser) -> ResolutionItem:
        """A person proposes a resolution. BLOCKED is stored and rejected with 422; AUTO executes and validates immediately; OPS or MANAGER waits for
        someone else's approval."""
        if not has_permission(viewer.role, "resolution.propose"):
            raise AppError("FORBIDDEN", "Only OPS users and above can propose resolutions")
        write = user_write_context(viewer, case_id)
        async with self._sessions() as s:
            state = await load_case_state(s, self._gateway, case_id, self._clock.now())
        async with transaction(self._sessions) as s:
            case = (await s.scalars(select(Case).where(Case.id == case_id).with_for_update().execution_options(populate_existing=True))).one_or_none()
            if case is None:
                raise not_found("Case", case_id)
            if case.status in CLOSED_CASE_STATUSES:
                raise AppError("CONFLICT", f"Case {case.display_id} is {case.status}")
            if await self._queries.pending_approval(s, case_id):
                raise AppError("CONFLICT", f"Case {case.display_id} already has a resolution waiting for approval")
            previous = await self._queries.rows_for_case(s, case_id)
            if any(r.status == "EXECUTING" for r in previous):
                raise AppError("CONFLICT", f"A resolution for {case.display_id} is executing")
            attempt = len(previous) + 1
            decision, failures = self._evaluate(state, body.actions, attempt, proposer="USER")
            resolution = await self._store(
                s, case, run_id=None, attempt=attempt, actions=body.actions, rationale=body.rationale, proposed_by=user_actor(viewer), decision=decision,
            )
            reasons = ", ".join(r.rule_id for r in decision.reasons) or "no rule"
            await self._audit.record(
                s,
                audit_from(
                    write, action="resolution.proposed", entity_type="resolution", entity_id=resolution.id,
                    summary=f"{viewer.name} proposed attempt {attempt} for {case.display_id}: {actions_summary(resolution.actions)}. Policy {decision.tier} ({reasons})",
                    after={"actions": resolution.actions, "policy": decision.to_json(), "preconditionFailures": [f.to_json() for f in failures]},
                ),
            )
            approval_id: str | None = None
            if decision.tier in ("OPS", "MANAGER"):
                approval_id = await self._request_approval(
                    s, case, resolution, decision.tier, user_actor(viewer), write,
                    f"Approval requested from {'a manager' if decision.tier == 'MANAGER' else 'another OPS user'} for {case.display_id}: {actions_summary(resolution.actions)}",
                )
            elif decision.tier == "AUTO":
                await self._cases.set_status(s, case_id, "EXECUTING", f"{case.display_id} is executing an AUTO-tier resolution", write)
        if resolution.status == "BLOCKED":
            await self._publish(resolution.id, case_id)
            raise AppError(
                "VALIDATION_FAILED", "Policy blocked this proposal",
                {"resolutionId": resolution.id, "policy": resolution.policy, "preconditionFailures": [f.to_json() for f in failures]},
            )
        if approval_id:
            await self._publish(resolution.id, case_id)
            await self._announce_approval(approval_id, case_id)
            async with self._sessions() as s:
                return await self._queries.item(s, resolution.id)
        return await self.finish(resolution.id, write)

    async def _request_approval(
        self, s: AsyncSession, case: Case, resolution: Resolution, tier: str, requested_by: dict[str, str], write: WriteContext, summary: str
    ) -> str:
        approval_id = new_id("approval")
        s.add(
            Approval(
                id=approval_id, resolution_id=resolution.id, case_id=case.id, tier=tier, status="PENDING", requested_by=requested_by,
                requested_at=self._clock.now(), decided_by=None, comment=None, decided_at=None,
            )
        )
        await s.flush()
        await self._audit.record(s, audit_from(write, action="approval.requested", entity_type="approval", entity_id=approval_id, summary=summary))
        await self._cases.set_status(s, case.id, "AWAITING_APPROVAL", f"{case.display_id} is waiting for {tier} approval", write)
        return approval_id

    async def _announce_approval(self, approval_id: str, case_id: str) -> None:
        if self._approval_item is not None:
            item = await self._approval_item(approval_id)
            self._events.publish(ROOM_OPS, OpsEvents.APPROVAL_REQUESTED, item)
            self._events.publish(room_case(case_id), OpsEvents.APPROVAL_REQUESTED, item)

    async def undo(self, resolution_id: str, viewer: SessionUser) -> ResolutionItem:
        """Undo a validated resolution that posted a capture to the ledger (D070). Not a shortcut: the case reopens and a REVERSE_LEDGER_ENTRY proposal goes
        through the same policy, approval, executor and validator as any fix. Only POST_LEDGER_ENTRY has a reversing action in the catalog."""
        if not has_permission(viewer.role, "resolution.undo"):
            raise AppError("FORBIDDEN", "Only OPS users and above can undo a resolution")
        async with self._sessions() as s:
            item = await self._queries.item(s, resolution_id)
            case = await s.get(Case, item.case_id)
            if case is None:
                raise not_found("Case", item.case_id)
            if case.status != "RESOLVED":
                raise AppError("CONFLICT", f"Case {case.display_id} is {case.status.lower()}; only a resolved case can be undone")
            if item.status != "VALIDATED" or item.validation is None or item.validation.verdict != "PASS":
                raise AppError("CONFLICT", "Only a resolution that passed validation can be undone")
            latest = (await s.scalars(select(Resolution.id).where(Resolution.case_id == case.id).order_by(desc(Resolution.attempt)).limit(1))).first()
            if latest != resolution_id:
                raise AppError("CONFLICT", "Only the latest resolution on a case can be undone")
            rows = (await s.scalars(select(Execution).where(Execution.resolution_id == resolution_id, Execution.status == "SUCCEEDED"))).all()
        journal_id = next((e.result["journalId"] for e in rows if e.action["type"] == "POST_LEDGER_ENTRY" and e.result and isinstance(e.result.get("journalId"), str)), None)
        if journal_id is None:
            raise AppError("CONFLICT", "Nothing to undo: this resolution did not post a ledger entry")

        write = user_write_context(viewer, case.id)
        previous = case.resolution
        async with transaction(self._sessions) as s:
            await self._cases.set_status(s, case.id, "OPEN", f"{case.display_id}: reopened by {viewer.name} to undo attempt {item.attempt}", write)
        try:
            body = ProposeActionsBody.model_validate(
                {
                    "actions": [{"type": "REVERSE_LEDGER_ENTRY", "params": {"journalId": journal_id, "undoOf": resolution_id}}],
                    "rationale": f"Undo attempt {item.attempt}: reverse capture journal {journal_id}",
                }
            )
            return await self.propose(case.id, body, viewer)
        except Exception:
            # Nothing was proposed (or it was blocked): put the case back as it was so it is not left open by a failed undo.
            async with transaction(self._sessions) as s:
                await self._cases.set_status(s, case.id, "RESOLVED", f"{case.display_id}: undo was not possible, case restored", write, resolution=previous)
            raise

    # ── Execute, validate, close ─────────────────────────────────────────────
    async def finish(self, resolution_id: str, write: WriteContext, *, on_failure: str = "OPEN") -> ResolutionItem:
        """Execute, validate, close. Called for AUTO proposals and after an approval. PASS resolves the case (or leaves it ESCALATED when the resolution
        escalated); PARTIAL, FAIL and execution failures send it back to OPEN with the outcome visible on the resolution."""
        execution = await self.execute(resolution_id, write)
        if not execution.ok:
            return await self.close_execution_failed(resolution_id, execution, write, on_failure=on_failure)
        validation = await self.validate(resolution_id)
        return await self.close_validated(resolution_id, validation.verdict, write, on_failure=on_failure)

    async def execute(self, resolution_id: str, write: WriteContext) -> ExecutionOutcome:
        """Runs a resolution's actions. Does not validate or close; callers decide what happens next (the agent's replan node uses this)."""
        return await self._executor.execute(resolution_id, write)

    async def validate(self, resolution_id: str) -> ValidationResult:
        return await self._validator.validate(resolution_id, _VALIDATOR_CTX)

    async def _context(self, resolution_id: str, write: WriteContext) -> tuple[Resolution, WriteContext]:
        async with self._sessions() as s:
            resolution = await self._queries.row(s, resolution_id)
        return resolution, replace(write, case_id=resolution.case_id, run_id=resolution.run_id)

    async def close_execution_failed(self, resolution_id: str, execution: ExecutionOutcome, write: WriteContext, *, on_failure: str = "OPEN") -> ResolutionItem:
        """Closes a resolution whose execution itself failed (never validated)."""
        resolution, ctx = await self._context(resolution_id, write)
        escalated = on_failure == "ESCALATE"
        failed = next((s for s in execution.steps if s.status == "FAILED"), None)
        message = failed.error["message"] if failed and failed.error else "unknown error"
        step = (failed.index if failed else 0) + 1
        outcome = "escalated to a person" if escalated else "reopened"
        await self._close(resolution, "EXECUTION_FAILED", "ESCALATED" if escalated else "OPEN", f"Execution failed at step {step}: {message}. Case {outcome}", ctx, None)
        await self._refresh_detection(resolution.case_id)
        await self._publish(resolution_id, resolution.case_id)
        return await self._item(resolution_id)

    async def escalate_execution_error(self, resolution_id: str, message: str, write: WriteContext) -> ResolutionItem:
        """Closes a resolution as ESCALATED when `execute()` itself raises before returning an outcome (for example a database error after the retries are
        used up), so there is a real resolution row to close but no execution outcome to close it with."""
        resolution, ctx = await self._context(resolution_id, write)
        await self._close(resolution, "EXECUTION_FAILED", "ESCALATED", f"Execution could not complete: {message}. Case escalated to a person", ctx, None)
        await self._refresh_detection(resolution.case_id)
        await self._publish(resolution_id, resolution.case_id)
        return await self._item(resolution_id)

    async def close_validated(self, resolution_id: str, verdict: str, write: WriteContext, *, on_failure: str = "OPEN") -> ResolutionItem:
        """Closes a resolution that ran the validator (PASS resolves; PARTIAL or FAIL reopens or escalates)."""
        resolution, ctx = await self._context(resolution_id, write)
        actions = [_ACTION.validate_python(a) for a in resolution.actions]
        escalates = any(a.type == "ESCALATE_TO_HUMAN" for a in actions)
        summary = f"{actions_summary(resolution.actions)}. Validator {verdict} on attempt {resolution.attempt}"
        if verdict == "PASS" and is_undo_proposal(actions):
            # The reversal worked, but the case's original problem is back, so it stays open (D070).
            await self._close(resolution, "VALIDATED", "OPEN", f"{summary}. Undone, case reopened", ctx, None)
        elif verdict == "PASS":
            by = "AGENT" if resolution.proposed_by["type"] == "AGENT" else "USER"
            await self._close(resolution, "VALIDATED", "ESCALATED" if escalates else "RESOLVED", summary, ctx, None if escalates else {"by": by, "summary": summary, "runId": resolution.run_id})
        else:
            outcome = "escalated to a person" if on_failure == "ESCALATE" else "reopened"
            await self._close(resolution, "VALIDATED", "ESCALATED" if on_failure == "ESCALATE" else "OPEN", f"{summary}. Case {outcome}", ctx, None)
        await self._refresh_detection(resolution.case_id)
        await self._publish(resolution_id, resolution.case_id)
        return await self._item(resolution_id)

    async def escalate_without_proposal(self, case_id: str, summary: str, write: WriteContext) -> None:
        """Moves the case straight to ESCALATED when no resolution ever existed (the agent's budget guard can trip before the policy gate)."""
        async with transaction(self._sessions) as s:
            await self._cases.set_status(s, case_id, "ESCALATED", summary, write)
        async with self._sessions() as s:
            items = await self._case_queries.list_items(s, [case_id])
        if items:
            payload = items[0].to_json()
            self._events.publish(ROOM_OPS, OpsEvents.CASE_UPDATED, payload)
            self._events.publish(room_case(case_id), OpsEvents.CASE_UPDATED, payload)

    async def _close(self, resolution: Resolution, status: str, case_status: str, summary: str, ctx: WriteContext, case_resolution: dict[str, Any] | None) -> None:
        async with transaction(self._sessions) as s:
            row = (await s.scalars(select(Resolution).where(Resolution.id == resolution.id).execution_options(populate_existing=True))).one()
            row.status = status
            row.updated_at = self._clock.now()
            display_id = (await s.scalars(select(Case.display_id).where(Case.id == resolution.case_id))).first() or resolution.case_id
            # The ESCALATE action may already have moved the case; set_status audits only a real change.
            if case_status == "RESOLVED":
                await self._cases.set_status(s, resolution.case_id, case_status, f"{display_id}: {summary}", ctx, resolution=case_resolution)
            else:
                await self._cases.set_status(s, resolution.case_id, case_status, f"{display_id}: {summary}", ctx)

    async def _refresh_detection(self, case_id: str) -> None:
        """Re-runs detection for the case's entities so payment flags and cases reflect the fix."""
        async with self._sessions() as s:
            row = await s.get(Case, case_id)
        if row is None:
            return
        refs = row.entity_refs
        if refs.get("orderId"):
            await self._reconciliation.check_orders([refs["orderId"]])
        if row.type == "SETTLEMENT_MISMATCH" and refs.get("batchId"):
            await self._reconciliation.check_batches([refs["batchId"]])
        await self._cases.refresh_stored_matrix(self._sessions, case_id)

    async def _item(self, resolution_id: str) -> ResolutionItem:
        async with self._sessions() as s:
            return await self._queries.item(s, resolution_id)

    async def _publish(self, resolution_id: str, case_id: str) -> None:
        async with self._sessions() as s:
            item = await self._queries.item(s, resolution_id)
            case_items = await self._case_queries.list_items(s, [case_id])
        payload = item.to_json()
        self._events.publish(ROOM_OPS, OpsEvents.RESOLUTION_UPDATED, payload)
        self._events.publish(room_case(case_id), OpsEvents.RESOLUTION_UPDATED, payload)
        if case_items:
            case_payload = case_items[0].to_json()
            self._events.publish(ROOM_OPS, OpsEvents.CASE_UPDATED, case_payload)
            self._events.publish(room_case(case_id), OpsEvents.CASE_UPDATED, case_payload)
