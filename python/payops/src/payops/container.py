"""The composition root: wires ports to adapters and services to each other. The API, jobs, the simulator and tests all build their services here."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .domain.gateway import PaymentGateway
from .infra.gateway import SimulatorGateway
from .ports import Clock, EventPublisher, NoopPublisher, SystemClock
from .services.agent_control import AgentControlService
from .services.approvals import ApprovalQueryService
from .services.audit import AuditService
from .services.cases import CaseQueryService
from .services.overview import OverviewService
from .services.payments import PaymentQueryService
from .services.resolutions import ResolutionQueryService
from .services.runs import RunQueryService
from .services.webhooks import WebhookQueryService
from .services.workflow import CaseNoteQueryService, HandoffService, SavedViewQueryService
from .services.writes.action_runtime import ExecDeps
from .services.writes.approvals import ApprovalService
from .services.writes.cases import CaseWriteService
from .services.writes.disputes import DisputeWriteService
from .services.writes.executor import ExecutorService
from .services.writes.ledger import LedgerWriteService
from .services.writes.orders import OrderService
from .services.writes.payments import PaymentWriteService
from .services.writes.reconciliation import ReconciliationService
from .services.writes.refunds import RefundWriteService
from .services.writes.resolutions import ResolutionService
from .services.writes.validator import ValidatorService
from .services.writes.webhooks import WebhookConsumer, WebhookEventService


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
    audit: AuditService
    webhooks: WebhookQueryService
    handoff: HandoffService
    notes: CaseNoteQueryService
    views: SavedViewQueryService
    resolutions: ResolutionQueryService
    approvals: ApprovalQueryService
    runs: RunQueryService
    executor: ExecutorService
    validator: ValidatorService
    webhook_events: WebhookEventService
    case_writes: CaseWriteService
    reconciliation: ReconciliationService
    resolution_service: ResolutionService
    approval_service: ApprovalService


def build_services(
    sessions: async_sessionmaker[AsyncSession], *, clock: Clock | None = None, events: EventPublisher | None = None, gateway: PaymentGateway | None = None
) -> Services:
    clock = clock or SystemClock()
    gateway = gateway or SimulatorGateway(sessions, clock)
    cases = CaseQueryService(clock, gateway)
    resolutions = ResolutionQueryService(clock, gateway)
    cases.resolutions = resolutions
    audit = AuditService(clock)
    orders, payments = OrderService(clock, audit), PaymentWriteService(clock, audit)
    ledger = LedgerWriteService(clock, audit)
    refunds = RefundWriteService(clock, audit, ledger, payments)
    deps = ExecDeps(sessions, clock, gateway, orders, ledger, payments, refunds, DisputeWriteService(clock, audit), CaseWriteService(clock, audit, gateway))
    events = events or NoopPublisher()
    consumer = WebhookConsumer(sessions, gateway, audit, orders, payments, ledger, refunds)
    webhook_events = WebhookEventService(sessions, clock, audit, consumer, gateway)
    reconciliation = ReconciliationService(sessions, clock, gateway, deps.cases, cases, events)
    executor = ExecutorService(deps, audit, events, resolutions)
    validator = ValidatorService(sessions, clock, gateway, audit, resolutions)
    resolution_service = ResolutionService(sessions, clock, gateway, audit, events, deps.cases, cases, reconciliation, resolutions, executor, validator)
    approvals = ApprovalQueryService(clock, cases, resolutions)
    approval_service = ApprovalService(sessions, clock, audit, events, deps.cases, approvals, resolution_service)

    async def approval_payload(approval_id: str) -> dict[str, object]:
        async with sessions() as s:
            return (await approvals.item(s, approval_id)).to_json()

    resolution_service.use_approval_items(approval_payload)
    if isinstance(gateway, SimulatorGateway):
        # The simulated gateway delivers webhooks to our log, which runs the consumer and records the attempt.
        gateway.set_webhook_sink(webhook_events.receive)
    return Services(
        sessions=sessions,
        clock=clock,
        events=events,
        gateway=gateway,
        cases=cases,
        payments=PaymentQueryService(clock, gateway, cases),
        overview=OverviewService(clock, gateway),
        agent_control=AgentControlService(),
        audit=audit,
        webhooks=WebhookQueryService(),
        handoff=HandoffService(clock),
        notes=CaseNoteQueryService(),
        views=SavedViewQueryService(),
        resolutions=resolutions,
        approvals=approvals,
        runs=RunQueryService(resolutions),
        executor=executor,
        validator=validator,
        webhook_events=webhook_events,
        case_writes=deps.cases,
        reconciliation=reconciliation,
        resolution_service=resolution_service,
        approval_service=approval_service,
    )
