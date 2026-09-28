/**
 * The state matrix: one payment as each system sees it. The gateway is the reference for money
 * movement; every other cell is marked `mismatch` when it disagrees with what the gateway did.
 */
import {
  SYSTEMS,
  formatMoney,
  type MatrixCell,
  type StateMatrix,
  type SystemKey,
} from '@payops/shared';
import type { GatewayWebhookDelivery } from '../ports/gateway';
import {
  PAID_ORDER_STATUSES,
  captureCreditMinor,
  capturedGw,
  capturedTotalMinor,
  CAPTURE_KNOWN_STATUSES,
  expectedFee,
  gatewayProcessedRefundMinor,
  heldCaptures,
  isCaptured,
  outstandingCapturedMinor,
  refundPostedMinor,
} from './facts';
import type { OrderSnapshot } from './snapshot';

/** Display codes used in ledger / settlement / webhook cells. Also read by list views. */
export const LEDGER_CODES = {
  posted: 'POSTED',
  missing: 'MISSING',
  partial: 'PARTIAL',
  refundMissing: 'REFUND MISSING',
  notExpected: 'NOT EXPECTED',
} as const;

export const SETTLEMENT_CODES = {
  settled: 'SETTLED',
  feeMismatch: 'FEE MISMATCH',
  pending: 'PENDING',
  notExpected: 'NOT EXPECTED',
} as const;

export function buildMatrix(s: OrderSnapshot): StateMatrix {
  const cells: Record<SystemKey, MatrixCell> = {
    GATEWAY: gatewayCell(s),
    ORDER: orderCell(s),
    LEDGER: ledgerCell(s),
    WEBHOOK: webhookCell(s),
    SETTLEMENT: settlementCell(s),
  };
  return { cells, mismatched: SYSTEMS.filter((k) => cells[k].mismatch) };
}

/** A matrix with empty cells, for cases that have no single payment to show (e.g. a batch). */
export function blankMatrix(overrides: Partial<Record<SystemKey, Partial<MatrixCell>>> = {}): StateMatrix {
  const cells = Object.fromEntries(
    SYSTEMS.map((k) => [k, cell(k, { reference: k === 'GATEWAY', ...overrides[k] })]),
  ) as Record<SystemKey, MatrixCell>;
  return { cells, mismatched: SYSTEMS.filter((k) => cells[k].mismatch) };
}

function cell(system: SystemKey, fields: Partial<Omit<MatrixCell, 'system'>>): MatrixCell {
  return {
    system,
    status: null,
    amountMinor: null,
    at: null,
    detail: null,
    mismatch: false,
    reference: false,
    ...fields,
  };
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function gatewayCell(s: OrderSnapshot): MatrixCell {
  const primary = s.primaryGw;
  if (!primary) {
    return cell('GATEWAY', { reference: true, detail: 'No gateway payment for this order' });
  }
  const captured = capturedGw(s);
  // A second capture that was refunded in full is no longer a live duplicate.
  const duplicate = heldCaptures(s).length > 1;
  let detail: string | null = null;
  if (duplicate) {
    detail = `${captured.length} captures on one order`;
  } else if (s.gwRefunds.length > 0) {
    detail = s.gwRefunds.map((r) => `Refund ${formatMoney(r.amountMinor)} ${r.status}`).join(' · ');
  } else if (primary.card) {
    detail = `${primary.method} · ${primary.card.network} ${primary.card.last4}`;
  } else {
    detail = primary.method;
  }
  return cell('GATEWAY', {
    status: captured.length > 1 ? `CAPTURED ×${captured.length}` : primary.status,
    amountMinor: captured.length > 0 ? capturedTotalMinor(s) : primary.amountMinor,
    at: iso(primary.capturedAt ?? primary.createdAt),
    detail,
    mismatch: duplicate,
    reference: true,
  });
}

function orderCell(s: OrderSnapshot): MatrixCell {
  const { order } = s;
  const last = order.timeline[order.timeline.length - 1];
  const paid = PAID_ORDER_STATUSES.has(order.status);
  const moneyHeld = outstandingCapturedMinor(s) > 0;
  const nothingCaptured = capturedGw(s).length === 0;
  return cell('ORDER', {
    status: order.status,
    amountMinor: order.amountMinor,
    at: last ? last.at : iso(order.createdAt),
    detail: s.payment ? `Internal payment ${s.payment.status}` : null,
    mismatch: (moneyHeld && !paid) || (paid && nothingCaptured),
  });
}

function ledgerCell(s: OrderSnapshot): MatrixCell {
  const primary = s.primaryGw;
  const primaryCaptured = isCaptured(primary);
  const anyCaptured = capturedGw(s).length > 0;
  const credit = captureCreditMinor(s);
  const hasCaptureEntries = s.ledger.some((e) => e.refundId === null);
  const refundGap = gatewayProcessedRefundMinor(s) - refundPostedMinor(s);
  const lastPosted = s.ledger.reduce<Date | null>((acc, e) => (!acc || e.postedAt > acc ? e.postedAt : acc), null);

  let status: string;
  let detail: string | null = null;
  if (!primary || !primaryCaptured) {
    if (s.ledger.length > 0) {
      status = LEDGER_CODES.partial;
      detail = 'Ledger entries without a gateway capture';
    } else if (anyCaptured) {
      status = LEDGER_CODES.missing;
      detail = `No capture credit for ${formatMoney(capturedTotalMinor(s))}`;
    } else {
      status = LEDGER_CODES.notExpected;
    }
  } else if (credit === 0) {
    status = LEDGER_CODES.missing;
    detail = `No capture credit for ${formatMoney(primary.amountMinor)}`;
  } else if (credit !== primary.amountMinor) {
    status = LEDGER_CODES.partial;
    detail = `Credit ${formatMoney(credit)} vs captured ${formatMoney(primary.amountMinor)}`;
  } else if (refundGap > 0) {
    status = LEDGER_CODES.refundMissing;
    detail = `Refund ${formatMoney(refundGap)} processed at gateway, not posted`;
  } else {
    status = LEDGER_CODES.posted;
    detail = 'Capture journal posted';
  }
  const mismatch =
    status === LEDGER_CODES.missing || status === LEDGER_CODES.partial || status === LEDGER_CODES.refundMissing;
  return cell('LEDGER', {
    status,
    amountMinor: hasCaptureEntries ? credit : null,
    at: iso(lastPosted),
    detail,
    mismatch,
  });
}

/** The payment.captured delivery of the primary gateway payment plus any refund deliveries. */
export function relevantDeliveries(s: OrderSnapshot): GatewayWebhookDelivery[] {
  const primaryId = s.primaryGw?.id;
  return s.webhooks.filter(
    (w) => (w.event === 'payment.captured' && w.gwPaymentId === primaryId) || w.event.startsWith('refund.'),
  );
}

function lastAttemptAt(w: GatewayWebhookDelivery): string | null {
  return w.attempts[w.attempts.length - 1]?.at ?? null;
}

function latest(deliveries: GatewayWebhookDelivery[]): GatewayWebhookDelivery | undefined {
  return [...deliveries].sort((a, b) => (lastAttemptAt(a) ?? '').localeCompare(lastAttemptAt(b) ?? '')).pop();
}

/**
 * A failed delivery stops mattering once our records caught up another way (for example an
 * analyst marked the order paid, or synced the refund). It is still shown, but not as a mismatch.
 */
export function deliveryCaughtUp(s: OrderSnapshot, w: GatewayWebhookDelivery): boolean {
  if (w.event === 'payment.captured') {
    return s.payment !== null && s.payment.gwPaymentId === w.gwPaymentId && CAPTURE_KNOWN_STATUSES.has(s.payment.status);
  }
  if (w.event === 'refund.processed' || w.event === 'refund.failed') {
    const want = w.event === 'refund.processed' ? 'PROCESSED' : 'FAILED';
    return s.refunds.some((r) => r.gwRefundId !== null && r.gwRefundId === w.gwRefundId && r.status === want);
  }
  return false;
}

function failureCode(w: GatewayWebhookDelivery): string {
  const last = w.attempts[w.attempts.length - 1];
  const code = last?.httpStatus != null ? `HTTP ${last.httpStatus}` : 'TIMEOUT';
  return `${code} ×${w.attempts.length}`;
}

function webhookCell(s: OrderSnapshot): MatrixCell {
  const relevant = relevantDeliveries(s);
  const failedAll = relevant.filter((w) => w.finalStatus === 'FAILED');
  const failed = latest(failedAll.filter((w) => !deliveryCaughtUp(s, w)));
  if (failed) {
    return cell('WEBHOOK', {
      status: failureCode(failed),
      at: lastAttemptAt(failed),
      detail: failed.event,
      mismatch: true,
    });
  }
  const caughtUp = latest(failedAll);
  if (caughtUp) {
    return cell('WEBHOOK', {
      status: failureCode(caughtUp),
      at: lastAttemptAt(caughtUp),
      detail: `${caughtUp.event} not delivered; internal records updated another way`,
    });
  }
  const pending = latest(relevant.filter((w) => w.finalStatus === 'PENDING'));
  if (pending) {
    return cell('WEBHOOK', { status: 'PENDING', at: lastAttemptAt(pending), detail: pending.event });
  }
  const delivered = latest(relevant.filter((w) => w.finalStatus === 'DELIVERED'));
  if (delivered) {
    return cell('WEBHOOK', { status: 'DELIVERED', at: lastAttemptAt(delivered), detail: delivered.event });
  }
  return cell('WEBHOOK', { status: 'NONE' });
}

function settlementCell(s: OrderSnapshot): MatrixCell {
  const primary = s.primaryGw;
  const line = primary ? s.settlementLines.find((l) => l.gwPaymentId === primary.id) : undefined;
  if (line) {
    const expected = expectedFee(line.grossMinor, s.merchant);
    const charged = line.feeMinor + line.taxMinor;
    const contract = expected.feeMinor + expected.taxMinor;
    const feeMismatch = charged !== contract;
    return cell('SETTLEMENT', {
      status: feeMismatch ? SETTLEMENT_CODES.feeMismatch : SETTLEMENT_CODES.settled,
      amountMinor: line.netMinor,
      at: line.settledOn.toISOString(),
      detail: feeMismatch
        ? `Fee ${formatMoney(charged)} vs contract ${formatMoney(contract)}`
        : `Batch ${line.batchId}`,
      mismatch: feeMismatch,
    });
  }
  if (isCaptured(primary)) {
    return cell('SETTLEMENT', { status: SETTLEMENT_CODES.pending, detail: 'Awaiting settlement file' });
  }
  return cell('SETTLEMENT', { status: SETTLEMENT_CODES.notExpected });
}
