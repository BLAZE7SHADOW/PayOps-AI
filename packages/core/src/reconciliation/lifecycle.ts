/**
 * Merged, chronological lifecycle of one order across every system. This is what an analyst
 * would otherwise assemble by hand from four dashboards. Titles are plain ops language.
 */
import { formatMoney, type LifecycleEvent, type LifecycleTone, type OrderStatus } from '@payops/shared';
import type { OrderSnapshot } from './snapshot';

/** Tie-break for events at the same instant: the order money actually flows through systems. */
const SYSTEM_ORDER: Record<LifecycleEvent['system'], number> = {
  RISK: 0,
  ORDER: 1,
  GATEWAY: 2,
  WEBHOOK: 3,
  LEDGER: 4,
  REFUND: 5,
  SETTLEMENT: 6,
};

/** Failed attempts are only interesting as a pattern. */
const RISK_MIN_FAILED_ATTEMPTS = 3;

const ORDER_TONE: Record<OrderStatus, LifecycleTone> = {
  PENDING: 'neutral',
  PAID: 'ok',
  FULFILLED: 'ok',
  FAILED: 'bad',
  CANCELLED: 'warn',
};

const numberFormat = new Intl.NumberFormat('en-IN');

export function buildLifecycle(s: OrderSnapshot): LifecycleEvent[] {
  const events: LifecycleEvent[] = [
    ...orderEvents(s),
    ...gatewayEvents(s),
    ...webhookEvents(s),
    ...ledgerEvents(s),
    ...refundEvents(s),
    ...settlementEvents(s),
    ...riskEvents(s),
  ];
  return events
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        a.e.at.localeCompare(b.e.at) || SYSTEM_ORDER[a.e.system] - SYSTEM_ORDER[b.e.system] || a.i - b.i,
    )
    .map(({ e }) => e);
}

function orderEvents(s: OrderSnapshot): LifecycleEvent[] {
  const out: LifecycleEvent[] = [];
  const { order } = s;
  if (order.timeline.length === 0 || order.timeline[0]?.from !== null) {
    out.push({
      at: order.createdAt.toISOString(),
      system: 'ORDER',
      title: 'Order created',
      detail: formatMoney(order.amountMinor),
      tone: 'neutral',
    });
  }
  for (const t of order.timeline) {
    const reason = t.reason ? ` · ${t.reason}` : '';
    out.push(
      t.from === null
        ? {
            at: t.at,
            system: 'ORDER',
            title: 'Order created',
            detail: `${formatMoney(order.amountMinor)} · by ${t.by}`,
            tone: 'neutral',
          }
        : {
            at: t.at,
            system: 'ORDER',
            title: `Order ${t.from} to ${t.to}`,
            detail: `by ${t.by}${reason}`,
            tone: ORDER_TONE[t.to],
          },
    );
  }
  return out;
}

function gatewayEvents(s: OrderSnapshot): LifecycleEvent[] {
  const out: LifecycleEvent[] = [];
  const captures = s.gateway.filter((g) => g.capturedAt).sort((a, b) => a.capturedAt!.getTime() - b.capturedAt!.getTime());
  for (const g of s.gateway) {
    const card = g.card ? ` · ${g.card.network} ${g.card.last4} (${g.card.country})` : '';
    out.push({
      at: g.createdAt.toISOString(),
      system: 'GATEWAY',
      title: 'Gateway payment created',
      detail: `${g.id} · ${g.method}${card}`,
      tone: 'neutral',
    });
    if (g.status === 'FAILED') {
      out.push({
        at: g.createdAt.toISOString(),
        system: 'GATEWAY',
        title: 'Gateway payment failed',
        detail: g.id,
        tone: 'bad',
      });
    }
  }
  captures.forEach((g, index) => {
    const repeat = index > 0;
    out.push({
      at: g.capturedAt!.toISOString(),
      system: 'GATEWAY',
      title: repeat ? `Captured ${formatMoney(g.amountMinor)} again at gateway` : `Captured ${formatMoney(g.amountMinor)} at gateway`,
      detail: repeat ? `${g.id} · capture ${index + 1} for this order` : g.id,
      tone: repeat ? 'bad' : 'ok',
    });
  });
  return out;
}

function webhookEvents(s: OrderSnapshot): LifecycleEvent[] {
  const out: LifecycleEvent[] = [];
  for (const w of s.webhooks) {
    const total = w.attempts.length;
    w.attempts.forEach((a, i) => {
      const failed = a.httpStatus === null || a.httpStatus >= 400;
      const code = a.httpStatus === null ? (a.error ?? 'No response') : `HTTP ${a.httpStatus}`;
      const attempt = total > 1 ? `Attempt ${i + 1} of ${total} · ` : '';
      out.push({
        at: a.at,
        system: 'WEBHOOK',
        title: failed ? `${w.event} delivery failed` : `${w.event} delivered`,
        detail: `${attempt}${code} · ${numberFormat.format(a.latencyMs)} ms`,
        tone: failed ? 'bad' : 'ok',
      });
    });
  }
  return out;
}

function ledgerEvents(s: OrderSnapshot): LifecycleEvent[] {
  const journals = new Map<string, OrderSnapshot['ledger']>();
  for (const e of s.ledger) {
    const list = journals.get(e.journalId);
    if (list) list.push(e);
    else journals.set(e.journalId, [e]);
  }
  const out: LifecycleEvent[] = [];
  for (const legs of journals.values()) {
    const payable = legs.find((l) => l.account === 'MERCHANT_PAYABLE');
    const first = legs[0];
    if (!first) continue;
    const amount = (payable ?? first).amountMinor;
    const reversal = legs.some((l) => l.reversalOf !== null);
    const title = reversal
      ? 'Ledger reversal posted'
      : first.refundId
        ? 'Refund posted to ledger'
        : 'Capture posted to ledger';
    out.push({
      at: first.postedAt.toISOString(),
      system: 'LEDGER',
      title,
      detail: `${formatMoney(amount)} ${payable?.direction === 'DEBIT' ? 'debit' : 'credit'} to MERCHANT_PAYABLE · ${first.source}`,
      tone: reversal ? 'warn' : 'ok',
    });
  }
  return out;
}

function refundEvents(s: OrderSnapshot): LifecycleEvent[] {
  const out: LifecycleEvent[] = [];
  for (const r of s.refunds) {
    out.push({
      at: r.requestedAt.toISOString(),
      system: 'REFUND',
      title: 'Refund requested',
      detail: `${formatMoney(r.amountMinor)} · ${r.reason}`,
      tone: 'neutral',
    });
    if (r.status === 'PROCESSED' || r.status === 'FAILED') {
      out.push({
        at: r.updatedAt.toISOString(),
        system: 'REFUND',
        title: r.status === 'PROCESSED' ? 'Refund marked processed internally' : 'Refund failed internally',
        detail: formatMoney(r.amountMinor),
        tone: r.status === 'PROCESSED' ? 'ok' : 'bad',
      });
    }
  }
  for (const g of s.gwRefunds) {
    out.push({
      at: g.createdAt.toISOString(),
      system: 'REFUND',
      title: 'Refund initiated at gateway',
      detail: `${g.id} · ${formatMoney(g.amountMinor)}`,
      tone: 'neutral',
    });
    if (g.status === 'PROCESSED' && g.processedAt) {
      out.push({
        at: g.processedAt.toISOString(),
        system: 'REFUND',
        title: 'Refund processed at gateway',
        detail: `${g.id} · ${formatMoney(g.amountMinor)}`,
        tone: 'ok',
      });
    } else if (g.status === 'FAILED') {
      out.push({
        at: (g.processedAt ?? g.createdAt).toISOString(),
        system: 'REFUND',
        title: 'Refund failed at gateway',
        detail: g.id,
        tone: 'bad',
      });
    }
  }
  return out;
}

function settlementEvents(s: OrderSnapshot): LifecycleEvent[] {
  return s.settlementLines.map((l) => ({
    at: l.settledOn.toISOString(),
    system: 'SETTLEMENT' as const,
    title: `Settled in batch ${l.batchId}`,
    detail: `Gross ${formatMoney(l.grossMinor)} · fee ${formatMoney(l.feeMinor)} · tax ${formatMoney(l.taxMinor)} · net ${formatMoney(l.netMinor)}`,
    tone: 'neutral' as const,
  }));
}

function riskEvents(s: OrderSnapshot): LifecycleEvent[] {
  const failed = s.recentAttempts.filter((a) => a.result === 'FAILED').sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = failed[0];
  const last = failed[failed.length - 1];
  if (failed.length < RISK_MIN_FAILED_ATTEMPTS || !first || !last) return [];
  const countries = [...new Set(failed.map((a) => a.cardCountry).filter((c): c is string => c !== null))].sort();
  const spanMin = Math.max(1, Math.round((last.at.getTime() - first.at.getTime()) / 60_000));
  const codes = [...new Set(failed.map((a) => a.failureCode).filter((c): c is string => c !== null))].sort();
  return [
    {
      at: last.at.toISOString(),
      system: 'RISK',
      title: `${failed.length} failed payment attempts in ${spanMin} min`,
      detail: [
        countries.length ? `Card countries: ${countries.join(', ')}` : null,
        codes.length ? `Codes: ${codes.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      tone: 'warn',
    },
  ];
}
