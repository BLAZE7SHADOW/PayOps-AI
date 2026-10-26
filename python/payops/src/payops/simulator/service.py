"""Generates scenarios, resets the demo data and seeds the demo cases. (packages/simulator index.ts)"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..db.engine import transaction
from ..db.models import AuditEvent
from ..domain.ids import seeded_ids
from ..errors import AppError
from ..ports import Clock
from ..services.audit import AuditInput, AuditService
from ..services.writes.reconciliation import ReconciliationService
from .context import Created, ScenarioContext
from .noise import write_noise
from .scenario_info import SCENARIOS
from .scenarios import SCENARIO_WRITERS
from .undo import snapshot_demo_data, undo_last_reset, undo_status
from .world import WORLD, seed_world

_ACTOR = ("SYSTEM", "simulator", "Simulator")
GENERATED_ACTION = "simulator.generated"
DEMO_NOISE_PAYMENTS = 30
DEMO_BASE_SEED = 1000

#: Business and ops tables wiped by a reset. Users, sessions and the job queue are kept.
RESET_TABLES = (
    "validation_results", "executions", "approvals", "resolutions", "disputes", "gw_settlement_lines", "gw_webhook_deliveries", "webhook_events", "gw_refunds",
    "gw_payments", "ledger_entries", "refunds", "payment_attempts", "payments", "orders", "settlements", "support_notes", "devices", "customers", "merchants",
    "cases", "counters", "audit_events",
)  # fmt: skip


@dataclass
class GenerateResult:
    scenario: str
    seed: int
    created: Created
    cases_opened: list[dict[str, str]]

    def to_json(self) -> dict[str, Any]:
        return {"scenario": self.scenario, "seed": self.seed, "created": self.created.to_json(), "casesOpened": self.cases_opened}


def random_seed() -> int:
    return 1 + int(random.random() * 1_000_000)


def _is_unique_violation(err: IntegrityError) -> bool:
    return getattr(err.orig, "sqlstate", None) == "23505"


log = logging.getLogger("payops.simulator")


class SimulatorService:
    def __init__(
        self, sessions: async_sessionmaker[AsyncSession], clock: Clock, audit: AuditService, reconciliation: ReconciliationService, cassette_dir: Path | None,
        cooldown_seconds: float = 10.0,
    ) -> None:
        self._sessions = sessions
        # The demo is public, so a reset or undo by one visitor affects everyone. A short cooldown and a one-at-a-time lock stop button mashing; every reset first
        # saves a snapshot that Undo restores.
        self._cooldown = cooldown_seconds
        self._busy = False
        #: The demo cases load in the background after a reset: on the free hosted database they take a few minutes, longer than a proxy keeps a request open.
        #: The flag blocks another reset or undo meanwhile.
        self.loading_demo = False
        self._last_change = float("-inf")
        self._background: set[asyncio.Task[None]] = set()
        self._clock = clock
        self._audit = audit
        self._reconciliation = reconciliation
        self._cassette_dir = cassette_dir

    async def generate_scenario(self, scenario: str, seed: int | None = None, noise: int = 0) -> GenerateResult:
        """Writes a scenario (plus `noise` healthy payments) in one transaction, then runs detection on the touched orders and batches. The same (scenario,
        seed) twice is rejected with CONFLICT (it would recreate the same deterministic ids); pick another seed or reset."""
        seed = random_seed() if seed is None else seed
        key = f"{scenario}:{seed}"
        now = self._clock.now()
        title = next((s.title for s in SCENARIOS if s.key == scenario), scenario)

        def conflict() -> AppError:
            return AppError("CONFLICT", f"Scenario {scenario} with seed {seed} was already generated. Use another seed or reset the demo data.")

        async with self._sessions() as s:
            if (await s.scalars(select(AuditEvent.id).where(AuditEvent.action == GENERATED_ACTION, AuditEvent.entity_id == key).limit(1))).first():
                raise conflict()
        async with transaction(self._sessions) as s:
            await seed_world(s, now)
        try:
            async with transaction(self._sessions) as s:
                ctx = ScenarioContext(s, seeded_ids(key), now, WORLD)
                await SCENARIO_WRITERS[scenario](ctx)
                if noise > 0:
                    noise_ctx = ScenarioContext(s, seeded_ids(f"{key}:noise"), now, WORLD)
                    await write_noise(noise_ctx, noise)
                    await noise_ctx.flush_settlements()
                    ctx.created.payment_ids.extend(noise_ctx.created.payment_ids)
                    ctx.created.order_ids.extend(noise_ctx.created.order_ids)
                    ctx.created.batch_ids.extend(noise_ctx.created.batch_ids)
                await ctx.flush_settlements()
                a = _ACTOR
                await self._audit.record(
                    s,
                    AuditInput(
                        a[0], a[1], a[2], GENERATED_ACTION, "scenario", key,
                        f'Generated "{title}" (seed {seed}) with {len(ctx.created.payment_ids)} payments, {noise} of them background noise',
                        after=ctx.created.to_json(),
                    ),
                )
                created = ctx.created
        except IntegrityError as err:
            # Backstop for a concurrent request with the same seed: its deterministic ids collide.
            if _is_unique_violation(err):
                raise conflict() from err
            raise

        # Detection runs after the commit, exactly as it would for real traffic.
        orders = await self._reconciliation.check_orders(created.order_ids)
        batches = await self._reconciliation.check_batches(created.batch_ids)
        opened = [
            {"id": c.case.id, "displayId": c.case.display_id, "type": c.case.type} for c in [*orders.cases, *batches.cases] if c.created
        ]
        return GenerateResult(scenario, seed, created, opened)

    async def reset_demo_data(self) -> None:
        """Wipes all demo data (keeping users), re-seeds the world and records the reset."""
        async with transaction(self._sessions) as s:
            await s.execute(text(f"truncate {', '.join(chr(34) + t + chr(34) for t in RESET_TABLES)} cascade"))
            await seed_world(s, self._clock.now())
            a = _ACTOR
            await self._audit.record(s, AuditInput(a[0], a[1], a[2], "simulator.reset", "system", "demo-data", "Demo data reset and base world re-seeded"))

    async def snapshot(self) -> None:
        await snapshot_demo_data(self._sessions, self._clock)

    def _recorded_seed(self, key: str) -> int | None:
        """Seeds that have recorded AI responses, so every pre-loaded case can be investigated in REPLAY mode."""
        if self._cassette_dir is None:
            return None
        manifest = self._cassette_dir / "manifest.json"
        if not manifest.exists():
            return None
        return next((r["seed"] for r in json.loads(manifest.read_text()) if r["scenario"] == key), None)

    def recorded(self) -> list[Any]:
        """Scenario and seed pairs that have recorded model responses, so REPLAY can investigate them."""
        manifest = self._cassette_dir / "manifest.json" if self._cassette_dir else None
        return json.loads(manifest.read_text()) if manifest and manifest.exists() else []

    async def seed_demo_cases(self) -> None:
        """Generates the demo data set: every fault scenario once, plus healthy background payments. Used by the seed script and by the hosted demo's reset, so
        both give the same cases. Scenarios that already exist are skipped, so it is safe to run twice. Times are relative to the clock's "now"."""
        faults = [s for s in SCENARIOS if s.expected_case_type is not None]
        for i, info in enumerate(faults):
            recorded = self._recorded_seed(info.key)
            try:
                await self.generate_scenario(info.key, recorded if recorded is not None else DEMO_BASE_SEED + i, 0)
            except AppError as err:
                if err.code != "CONFLICT":
                    raise
        try:
            await self.generate_scenario("healthy_payment", DEMO_BASE_SEED, DEMO_NOISE_PAYMENTS)
        except AppError as err:
            if err.code != "CONFLICT":
                raise

    # ── Reset and undo, one at a time ────────────────────────────────────────
    async def _guarded(self, work: Callable[[], Awaitable[None]]) -> None:
        wait = self._cooldown - (time.monotonic() - self._last_change)
        if self._busy or self.loading_demo or wait > 0:
            seconds = max(1, int(-(-wait // 1)))
            raise AppError("RATE_LIMITED", f"Someone just reset or restored the demo. Try again in {seconds} seconds.")
        self._busy = True
        try:
            await work()
        finally:
            self._last_change = time.monotonic()
            self._busy = False

    async def status(self) -> dict[str, Any]:
        async with self._sessions() as s:
            return {**(await undo_status(s)).to_json(), "loadingDemo": self.loading_demo}

    async def reset(self, restore_demo: bool) -> dict[str, Any]:
        """Resets the demo data. With `restore_demo` the demo cases are regenerated in the background (poll `status` for `loadingDemo`); without it only the
        baseline world remains, which tests and clean LIVE walkthroughs rely on."""

        async def work() -> None:
            await self.snapshot()
            await self.reset_demo_data()

        await self._guarded(work)
        if restore_demo:
            self.loading_demo = True
            task = asyncio.get_running_loop().create_task(self._load_demo())
            self._background.add(task)
            task.add_done_callback(self._background.discard)
        return {"status": "ok", **await self.status()}

    async def _load_demo(self) -> None:
        try:
            await self.seed_demo_cases()
        except Exception:
            log.exception("demo cases failed to load after reset")
        finally:
            self.loading_demo = False
            self._last_change = time.monotonic()

    async def undo(self) -> dict[str, Any]:
        async def work() -> None:
            try:
                await undo_last_reset(self._sessions)
            except RuntimeError as err:
                raise AppError("CONFLICT", str(err)) from err

        await self._guarded(work)
        return {"status": "ok", **await self.status()}

    async def wait_for_demo(self) -> None:
        """Waits for the background demo load. Tests call this."""
        while self._background:
            await asyncio.gather(*list(self._background))

