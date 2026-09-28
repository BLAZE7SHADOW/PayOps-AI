/**
 * Action runtime types. Each ActionType has one handler with three parts:
 *  - preconditions: pure, plain-language reasons the action cannot run on this data (empty = ok)
 *  - execute: does the work through domain services and the gateway port
 *  - postconditions: pure checks the validator runs on FRESH data afterwards
 */
import type { ActionOf, ActionType, ValidationCheck } from '@payops/shared';
import type { Db } from '../db/client';
import type { CaseRow } from '../db/rows';
import type { ClockPort } from '../ports/clock';
import type { PaymentGatewayPort } from '../ports/gateway';
import type { BatchCheck } from '../reconciliation/settlement';
import type { OrderSnapshot } from '../reconciliation/snapshot';
import type { WriteContext } from '../services/audit.service';
import type { CaseService } from '../services/case.service';
import type { DisputeService } from '../services/dispute.service';
import type { LedgerService } from '../services/ledger.service';
import type { OrderService } from '../services/order.service';
import type { PaymentService } from '../services/payment.service';
import type { RefundService } from '../services/refund.service';
import type { BatchData } from '../services/snapshot.loader';

export interface BatchState {
  data: BatchData;
  /** D7 recomputed from the gateway lines and the merchant contract (dispute-aware). */
  check: BatchCheck;
}

/** Everything the handlers may read about a case, loaded fresh in one go. */
export interface CaseState {
  now: Date;
  case: CaseRow;
  order: OrderSnapshot | null;
  batch: BatchState | null;
}

export interface ExecDeps {
  db: Db;
  clock: ClockPort;
  gateway: PaymentGatewayPort;
  orders: OrderService;
  ledger: LedgerService;
  payments: PaymentService;
  refunds: RefundService;
  disputes: DisputeService;
  cases: CaseService;
}

export interface ExecContext {
  deps: ExecDeps;
  write: WriteContext;
  resolutionId: string;
}

export interface ExecOutcome {
  /** Plain-language outcome shown on the execution step. */
  summary: string;
  result: Record<string, unknown>;
}

export interface ActionHandler<T extends ActionType = ActionType> {
  type: T;
  preconditions(action: ActionOf<T>, state: CaseState): string[];
  execute(action: ActionOf<T>, state: CaseState, ctx: ExecContext): Promise<ExecOutcome>;
  postconditions(action: ActionOf<T>, state: CaseState, index: number): ValidationCheck[];
}

/** Builds a postcondition check with a stable id. */
export function postcondition(
  index: number,
  key: string,
  fields: Omit<ValidationCheck, 'id' | 'kind' | 'actionIndex'>,
): ValidationCheck {
  return { id: `a${index}.${key}`, kind: 'POSTCONDITION', actionIndex: index, ...fields };
}
