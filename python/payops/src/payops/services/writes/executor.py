"""Executes a resolution's actions in order. Every step:
1. claims an `executions` row by idempotency key (a replay finds the stored result instead),
2. re-checks preconditions on FRESH data (the world may have moved since the proposal),
3. runs the handler, records SUCCEEDED or FAILED, audits and publishes. Execution stops at the first FAILED step. Each
   step uses its own short transactions; nothing holds a transaction while calling the gateway. (packages/core
   execution/executor.service.ts)"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from typing import Any

from pydantic import TypeAdapter
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ...db.engine import transaction
from ...db.models import Execution, Resolution
from ...db.retry import with_serialization_retry
from ...domain.actions.idempotency import idempotency_key
from ...domain.actions.registry import preconditions_of
from ...domain.actions.types import CaseState
from ...domain.ids import new_id
from ...domain.source_records import project_case_source_records
from ...dto.actions import ACTION_META, CatalogAction
from ...dto.resolution import ExecutionStep
from ...errors import AppError
from ...infra.snapshots import load_case_state
from ...ports import Clock, EventPublisher
from ...realtime import ROOM_OPS, OpsEvents, room_case
from ..audit import AuditService, WriteContext, audit_from
from ..resolutions import ResolutionQueryService, to_execution_steps
from .action_runtime import ExecContext, ExecDeps, execute_action

_ACTION: TypeAdapter[CatalogAction] = TypeAdapter(CatalogAction)


@dataclass
class ExecutionOutcome:
    ok: bool
    steps: list[ExecutionStep]


def _record_facts(state: CaseState) -> list[dict[str, Any]]:
    """Compact copy of the source records, kept so the case page can show before and after (D060)."""
    return [
        {"system": r.system, "kind": r.kind, "id": r.id, "status": r.status, "amountMinor": r.amount_minor}
        for r in project_case_source_records(state).records
    ]


def _to_error(err: Exception) -> dict[str, str]:
    if isinstance(err, AppError):
        return {"code": err.code, "message": err.message}
    return {"code": "EXECUTION_ERROR", "message": str(err) or "Unexpected error"}


class ExecutorService:
    def __init__(
        self, deps: ExecDeps, audit: AuditService, events: EventPublisher, queries: ResolutionQueryService
    ) -> None:
        self._deps = deps
        self._sessions: async_sessionmaker[AsyncSession] = deps.sessions
        self._clock: Clock = deps.clock
        self._audit = audit
        self._events = events
        self._queries = queries
        self._background: set[asyncio.Task[None]] = set()

    async def execute(self, resolution_id: str, write: WriteContext) -> ExecutionOutcome:
        async with self._sessions() as s:
            resolution = await self._queries.row(s, resolution_id)
        ctx = replace(write, case_id=resolution.case_id, run_id=resolution.run_id)
        ok = True
        for index, raw in enumerate(resolution.actions):
            status = await self._run_step(resolution, index, _ACTION.validate_python(raw), ctx)
            if status != "SUCCEEDED":
                ok = False
                break
        async with self._sessions() as s:
            rows = (await s.scalars(select(Execution).where(Execution.resolution_id == resolution_id))).all()
        return ExecutionOutcome(ok, to_execution_steps(resolution, rows))

    async def _run_step(self, resolution: Resolution, index: int, action: CatalogAction, ctx: WriteContext) -> str:
        key = idempotency_key(resolution.id, index, action)
        async with transaction(self._sessions) as s:
            claimed_id = (
                await s.execute(
                    pg_insert(Execution)
                    .values(
                        id=new_id("execution"),
                        idempotency_key=key,
                        resolution_id=resolution.id,
                        case_id=resolution.case_id,
                        action_index=index,
                        action=action.to_json(),
                        status="STARTED",
                        started_at=self._clock.now(),
                    )
                    .on_conflict_do_nothing(index_elements=[Execution.idempotency_key])
                    .returning(Execution.id)
                )
            ).scalar_one_or_none()
            existing = (
                None
                if claimed_id
                else (await s.scalars(select(Execution).where(Execution.idempotency_key == key))).one_or_none()
            )
        if claimed_id is None:
            # Replay of a step that already ran: return what happened, never act twice.
            if existing is None:
                raise AppError("CONFLICT", f"Execution {key} vanished")
            if existing.status == "STARTED":
                raise AppError("CONFLICT", f"Step {index + 1} ({ACTION_META[action.type].label}) is already executing")
            return existing.status
        self._publish(resolution.id)

        error: dict[str, str] | None = None
        result: dict[str, Any] | None = None
        before: list[dict[str, Any]] | None = None
        try:
            async with self._sessions() as s:
                state = await load_case_state(s, self._deps.gateway, resolution.case_id, self._clock.now())
            before = _record_facts(state)
            failures = preconditions_of(action, state)
            if failures:
                status, summary = "FAILED", f"Not executed: {failures[0]}"
                error = {"code": "PRECONDITION_FAILED", "message": " ".join(failures)}
            else:
                outcome = await execute_action(action, state, ExecContext(self._deps, ctx, resolution.id))
                status, summary, result = "SUCCEEDED", outcome.summary, outcome.result
        except Exception as err:  # noqa: BLE001 - any failure of the action is recorded on the step, never raised past it
            status = "FAILED"
            error = _to_error(err)
            summary = f"{ACTION_META[action.type].label} failed: {error['message']}"

        # Recording the outcome is the one write here that could see a genuine serialization failure, and it is safe to
        # redo from scratch.
        async def record() -> None:
            async with transaction(self._sessions) as s:
                await s.execute(
                    update(Execution)
                    .where(Execution.id == claimed_id, Execution.status == "STARTED")
                    .values(
                        status=status,
                        summary=summary,
                        result=result,
                        error=error,
                        before=before,
                        finished_at=self._clock.now(),
                    )
                )
                outcome_text = summary if status == "SUCCEEDED" else f"FAILED. {summary}"
                await self._audit.record(
                    s,
                    audit_from(
                        ctx,
                        action="action.executed",
                        entity_type="resolution",
                        entity_id=resolution.id,
                        summary=f"Step {index + 1} {ACTION_META[action.type].label}: {outcome_text}",
                        after={
                            "index": index,
                            "type": action.type,
                            "status": status,
                            "idempotencyKey": key,
                            "error": error,
                        },
                    ),
                )

        await with_serialization_retry(record)
        self._publish(resolution.id)
        return status

    def _publish(self, resolution_id: str) -> None:
        """Fire and forget after commit; a failed read must never fail the execution."""

        async def run() -> None:
            try:
                async with self._sessions() as s:
                    item = await self._queries.item(s, resolution_id)
                payload = item.to_json()
                self._events.publish(ROOM_OPS, OpsEvents.RESOLUTION_UPDATED, payload)
                self._events.publish(room_case(item.case_id), OpsEvents.RESOLUTION_UPDATED, payload)
            except Exception:  # noqa: BLE001
                return

        task = asyncio.get_running_loop().create_task(run())
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def drain(self) -> None:
        """Waits for pending publishes. Tests call this; the server never needs to."""
        while self._background:
            await asyncio.gather(*list(self._background))
