"""The validator never trusts the executor or stored state: it loads a fresh case snapshot and checks (1) each action's postconditions and (2) global
invariants for the case entities (see `domain/validation.py`). Verdict: FAIL if any postcondition fails, PARTIAL if only an invariant fails, else PASS.
(packages/core validation/validator.service.ts)"""

from __future__ import annotations

from dataclasses import replace

from pydantic import TypeAdapter
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ...db.engine import transaction
from ...db.models import ValidationResult
from ...domain.actions.registry import postconditions_of
from ...domain.gateway import PaymentGateway
from ...domain.ids import new_id
from ...domain.validation import case_invariants, verdict_of
from ...dto.actions import CatalogAction, is_undo_proposal
from ...infra.snapshots import load_case_state
from ...ports import Clock
from ..audit import AuditService, WriteContext, audit_from
from ..resolutions import ResolutionQueryService

_ACTION: TypeAdapter[CatalogAction] = TypeAdapter(CatalogAction)


class ValidatorService:
    def __init__(self, sessions: async_sessionmaker[AsyncSession], clock: Clock, gateway: PaymentGateway, audit: AuditService, queries: ResolutionQueryService) -> None:
        self._sessions = sessions
        self._clock = clock
        self._gateway = gateway
        self._audit = audit
        self._queries = queries

    async def validate(self, resolution_id: str, write: WriteContext) -> ValidationResult:
        async with self._sessions() as s:
            resolution = await self._queries.row(s, resolution_id)
            state = await load_case_state(s, self._gateway, resolution.case_id, self._clock.now())
        actions = [_ACTION.validate_python(a) for a in resolution.actions]
        # An undo removes a capture credit on purpose, so "every system agrees" cannot hold afterwards (D070).
        invariants = [] if is_undo_proposal(actions) else case_invariants(state)
        checks = [*(c for i, a in enumerate(actions) for c in postconditions_of(a, state, i)), *invariants]
        verdict = verdict_of(checks)
        failed = [c for c in checks if not c.passed]
        row = ValidationResult(
            id=new_id("validation"), resolution_id=resolution_id, case_id=resolution.case_id, attempt=resolution.attempt, verdict=verdict,
            checks=[c.to_json() for c in checks], at=self._clock.now(),
        )
        async with transaction(self._sessions) as s:
            s.add(row)
            await s.flush()
            await self._audit.record(
                s,
                audit_from(
                    replace(write, case_id=resolution.case_id, run_id=resolution.run_id), action="resolution.validated", entity_type="resolution",
                    entity_id=resolution_id,
                    summary=f"Validator {verdict}: {len(checks) - len(failed)} of {len(checks)} checks passed on attempt {resolution.attempt}",
                    after={"verdict": verdict, "failed": [c.id for c in failed]},
                ),
            )
        return row
