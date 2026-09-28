/**
 * Composition root for the domain core: wires ports to adapters and services to each other.
 * The server, the simulator and tests all build their core through here.
 */
import type { Db } from './db/client';
import { SimulatorGatewayAdapter } from './adapters/gateway/simulator-gateway';
import { ExecutorService } from './execution/executor.service';
import { systemClock, type ClockPort } from './ports/clock';
import { noopPublisher, type EventPublisherPort } from './ports/events';
import type { PaymentGatewayPort } from './ports/gateway';
import { ApprovalService, type ApprovalContinuation } from './services/approval.service';
import { AuditService } from './services/audit.service';
import { CaseService } from './services/case.service';
import { DisputeService } from './services/dispute.service';
import { LedgerService } from './services/ledger.service';
import { OrderService } from './services/order.service';
import { OverviewService } from './services/overview.service';
import { PaymentService } from './services/payment.service';
import { PaymentQueryService } from './services/payment-query.service';
import { ReconciliationService } from './services/reconciliation.service';
import { RefundService } from './services/refund.service';
import { ResolutionQueryService } from './services/resolution-query.service';
import { ResolutionService } from './services/resolution.service';
import { WebhookConsumer } from './services/webhook-consumer';
import { ValidatorService } from './validation/validator.service';

/** Resumes an agent run's LangGraph thread after a human decides its approval (Phase 3). */
export interface AgentResumer {
  resume(runId: string, decision: 'APPROVE' | 'REJECT' | 'ESCALATE'): Promise<void>;
}

export interface CoreOptions {
  db: Db;
  clock?: ClockPort;
  events?: EventPublisherPort;
  /** Wired by apps/server once pg-boss is up; undefined in tests that never start an agent run. */
  agentResumer?: AgentResumer;
  gateway?: PaymentGatewayPort;
}

export interface Core {
  db: Db;
  clock: ClockPort;
  events: EventPublisherPort;
  gateway: PaymentGatewayPort;
  audit: AuditService;
  cases: CaseService;
  reconciliation: ReconciliationService;
  payments: PaymentQueryService;
  overview: OverviewService;
  // Phase 2 write side
  orders: OrderService;
  ledger: LedgerService;
  paymentWrites: PaymentService;
  refunds: RefundService;
  disputes: DisputeService;
  webhookConsumer: WebhookConsumer;
  resolutionQueries: ResolutionQueryService;
  executor: ExecutorService;
  validator: ValidatorService;
  resolutions: ResolutionService;
  approvals: ApprovalService;
}

export function createCore(opts: CoreOptions): Core {
  const { db } = opts;
  const clock = opts.clock ?? systemClock;
  const events = opts.events ?? noopPublisher;
  const gateway = opts.gateway ?? new SimulatorGatewayAdapter(db, clock);
  const audit = new AuditService(db, clock);
  const cases = new CaseService(db, clock, gateway, audit);
  const reconciliation = new ReconciliationService(db, clock, gateway, cases, events);

  const orders = new OrderService(clock, audit);
  const ledger = new LedgerService(clock, audit);
  const paymentWrites = new PaymentService(clock, audit);
  const refunds = new RefundService(clock, audit, ledger, paymentWrites);
  const disputes = new DisputeService(clock, audit);

  // The simulated gateway delivers webhooks straight to our consumer.
  const webhookConsumer = new WebhookConsumer(db, gateway, audit, orders, paymentWrites, ledger, refunds);
  if (gateway instanceof SimulatorGatewayAdapter) {
    gateway.setWebhookSink((event) => webhookConsumer.handle(event));
  }

  const resolutionQueries = new ResolutionQueryService(db, clock, gateway);
  cases.useResolutionViews(resolutionQueries);
  const executor = new ExecutorService(
    { db, clock, gateway, orders, ledger, payments: paymentWrites, refunds, disputes, cases },
    audit,
    events,
    resolutionQueries,
  );
  const validator = new ValidatorService(db, clock, gateway, audit, resolutionQueries);
  const resolutions = new ResolutionService(db, clock, gateway, audit, events, cases, reconciliation, resolutionQueries, executor, validator);

  const continuation: ApprovalContinuation = {
    async onApproved(resolution, write) {
      if (resolution.runId && opts.agentResumer) {
        await opts.agentResumer.resume(resolution.runId, 'APPROVE');
        return;
      }
      await resolutions.finish(resolution.id, write);
    },
    async onRejected(resolution) {
      if (resolution.runId && opts.agentResumer) await opts.agentResumer.resume(resolution.runId, 'REJECT');
      // Manual proposals: approval.service.ts already set resolution+case status; nothing else to do.
    },
    async onEscalated(resolution) {
      if (resolution.runId && opts.agentResumer) await opts.agentResumer.resume(resolution.runId, 'ESCALATE');
    },
  };
  const approvals = new ApprovalService(db, clock, audit, events, cases, resolutionQueries, continuation);
  resolutions.useApprovalItems((id) => approvals.item(id));

  return {
    db,
    clock,
    events,
    gateway,
    audit,
    cases,
    reconciliation,
    payments: new PaymentQueryService(db, clock, gateway, cases),
    overview: new OverviewService(db, clock, gateway),
    orders,
    ledger,
    paymentWrites,
    refunds,
    disputes,
    webhookConsumer,
    resolutionQueries,
    executor,
    validator,
    resolutions,
    approvals,
  };
}
