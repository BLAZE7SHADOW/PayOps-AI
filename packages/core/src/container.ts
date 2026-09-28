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

export interface CoreOptions {
  db: Db;
  clock?: ClockPort;
  events?: EventPublisherPort;
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
      // TODO(Phase 3): when resolution.runId is set, resume the agent's LangGraph thread
      // (boss.send('agent-resume', { runId })) instead; the graph then executes and validates.
      await resolutions.finish(resolution.id, write);
    },
  };
  const approvals = new ApprovalService(db, clock, audit, events, cases, resolutionQueries, continuation);

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
