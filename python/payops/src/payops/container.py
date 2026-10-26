"""The composition root: wires ports to adapters and services to each other. The API, jobs, the simulator and tests all build their services here."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .domain.gateway import PaymentGateway
from .infra.gateway import SimulatorGateway
from .ports import Clock, EventPublisher, NoopPublisher, SystemClock
from .services.agent_control import AgentControlService
from .services.cases import CaseQueryService
from .services.overview import OverviewService
from .services.payments import PaymentQueryService


@dataclass
class Services:
    sessions: async_sessionmaker[AsyncSession]
    clock: Clock
    events: EventPublisher
    gateway: PaymentGateway
    cases: CaseQueryService
    payments: PaymentQueryService
    overview: OverviewService
    agent_control: AgentControlService


def build_services(
    sessions: async_sessionmaker[AsyncSession], *, clock: Clock | None = None, events: EventPublisher | None = None, gateway: PaymentGateway | None = None
) -> Services:
    clock = clock or SystemClock()
    gateway = gateway or SimulatorGateway(sessions)
    cases = CaseQueryService(clock)
    return Services(
        sessions=sessions,
        clock=clock,
        events=events or NoopPublisher(),
        gateway=gateway,
        cases=cases,
        payments=PaymentQueryService(clock, gateway, cases),
        overview=OverviewService(clock, gateway),
        agent_control=AgentControlService(),
    )
