/**
 * Composition root for the domain core: wires ports to adapters and services to each other.
 * The server, the simulator and tests all build their core through here.
 */
import type { Db } from './db/client';
import { SimulatorGatewayAdapter } from './adapters/gateway/simulator-gateway';
import { systemClock, type ClockPort } from './ports/clock';
import { noopPublisher, type EventPublisherPort } from './ports/events';
import type { PaymentGatewayPort } from './ports/gateway';
import { AuditService } from './services/audit.service';
import { CaseService } from './services/case.service';
import { OverviewService } from './services/overview.service';
import { PaymentQueryService } from './services/payment-query.service';
import { ReconciliationService } from './services/reconciliation.service';

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
}

export function createCore(opts: CoreOptions): Core {
  const { db } = opts;
  const clock = opts.clock ?? systemClock;
  const events = opts.events ?? noopPublisher;
  const gateway = opts.gateway ?? new SimulatorGatewayAdapter(db);
  const audit = new AuditService(db, clock);
  const cases = new CaseService(db, clock, gateway, audit);
  return {
    db,
    clock,
    events,
    gateway,
    audit,
    cases,
    reconciliation: new ReconciliationService(db, clock, gateway, cases, events),
    payments: new PaymentQueryService(db, clock, gateway, cases),
    overview: new OverviewService(db, clock, gateway),
  };
}
