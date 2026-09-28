/**
 * Payment + Reconciliation tool groups (docs/03-agent-system.md §9). Phase 3 has one full
 * investigator (no specialist split yet, no Risk group), so tools are grouped only for the
 * context builder's "never contains" rule and for organizing baseline vs. follow-up.
 *
 * Each tool is a pure projector over the case's already-loaded `CaseState` (docs/02 §4.2: the
 * gateway and database were already read once by `loadCase`; tools never touch them again).
 * There are no write tools here — writes only happen in the executor.
 */
import type { CaseState } from '@payops/core';
import { formatMoney } from '@payops/shared';
import type { EvidenceSystem } from '@payops/shared';

export interface ToolEvidenceDraft {
  source: string;
  system: EvidenceSystem;
  entityRef: string;
  facts: Record<string, string | number | boolean>;
  observedAt: string;
}

export interface ToolDef {
  name: string;
  group: 'payment' | 'reconciliation';
  /** Always called by the baseline (deterministic) pass. */
  baseline: boolean;
  description: string;
  run(state: CaseState): ToolEvidenceDraft[];
}

const iso = (d: Date | null | undefined): string => (d ? d.toISOString() : new Date(0).toISOString());

const getInternalPayment: ToolDef = {
  name: 'getInternalPayment',
  group: 'payment',
  baseline: true,
  description: "Our internal payment record for this order: status, amount, which gateway payment it's linked to.",
  run(state) {
    const p = state.order?.payment;
    if (!p) return [];
    return [
      {
        source: 'getInternalPayment',
        system: 'ORDER',
        entityRef: p.id,
        facts: { status: p.status, amountMinor: p.amountMinor, gwPaymentId: p.gwPaymentId ?? 'none' },
        observedAt: iso(p.updatedAt ?? p.createdAt),
      },
    ];
  },
};

const getGatewayPayment: ToolDef = {
  name: 'getGatewayPayment',
  group: 'payment',
  baseline: true,
  description: 'The gateway payment(s) for this order: capture status, amount, method, refunded so far. The gateway is the reference system.',
  run(state) {
    const s = state.order;
    if (!s) return [];
    return s.gateway.map((g) => ({
      source: 'getGatewayPayment',
      system: 'GATEWAY' as const,
      entityRef: g.id,
      facts: {
        status: g.status,
        amountMinor: g.amountMinor,
        method: g.method,
        refundedMinor: g.refundedMinor,
        capturedAt: g.capturedAt ? g.capturedAt.toISOString() : 'not captured',
      },
      observedAt: iso(g.capturedAt ?? g.createdAt),
    }));
  },
};

const getOrder: ToolDef = {
  name: 'getOrder',
  group: 'payment',
  baseline: true,
  description: 'The order: current status and amount.',
  run(state) {
    const o = state.order?.order;
    if (!o) return [];
    return [
      {
        source: 'getOrder',
        system: 'ORDER',
        entityRef: o.id,
        facts: { status: o.status, amountMinor: o.amountMinor },
        observedAt: iso(o.updatedAt),
      },
    ];
  },
};

const getOrderTimeline: ToolDef = {
  name: 'getOrderTimeline',
  group: 'payment',
  baseline: false,
  description: 'Every status transition the order went through, in order, with the reason recorded for each.',
  run(state) {
    const s = state.order;
    if (!s) return [];
    return s.order.timeline.map((t, i) => ({
      source: 'getOrderTimeline',
      system: 'ORDER' as const,
      entityRef: s.order.id,
      facts: { index: i, from: t.from ?? 'none', to: t.to, reason: t.reason ?? 'none' },
      observedAt: t.at,
    }));
  },
};

const getWebhookDeliveries: ToolDef = {
  name: 'getWebhookDeliveries',
  group: 'payment',
  baseline: false,
  description: 'Every webhook delivery attempt for this order: event type, final status, HTTP codes seen by our consumer.',
  run(state) {
    const s = state.order;
    if (!s) return [];
    return s.webhooks.map((w) => ({
      source: 'getWebhookDeliveries',
      system: 'WEBHOOK' as const,
      entityRef: w.id,
      facts: {
        event: w.event,
        finalStatus: w.finalStatus,
        attempts: w.attempts.length,
        lastHttpStatus: w.attempts.at(-1)?.httpStatus ?? 0,
      },
      observedAt: w.createdAt.toISOString(),
    }));
  },
};

const getPaymentAttempts: ToolDef = {
  name: 'getPaymentAttempts',
  group: 'payment',
  baseline: false,
  description: 'The customer\'s payment attempts in the 24 hours before capture: outcomes and timing, for velocity signals.',
  run(state) {
    const s = state.order;
    if (!s) return [];
    return s.recentAttempts.map((a) => ({
      source: 'getPaymentAttempts',
      system: 'GATEWAY' as const,
      entityRef: a.id,
      facts: { outcome: a.result, amountMinor: a.amountMinor },
      observedAt: a.at.toISOString(),
    }));
  },
};

const getLedgerEntries: ToolDef = {
  name: 'getLedgerEntries',
  group: 'reconciliation',
  baseline: true,
  description: 'Ledger journals posted for this payment: direction, account, amount, whether it was reversed.',
  run(state) {
    const s = state.order;
    if (!s) return [];
    return s.ledger.map((l) => ({
      source: 'getLedgerEntries',
      system: 'LEDGER' as const,
      entityRef: l.id,
      facts: { account: l.account, direction: l.direction, amountMinor: l.amountMinor, source: l.source },
      observedAt: l.postedAt.toISOString(),
    }));
  },
};

const getRefund: ToolDef = {
  name: 'getRefund',
  group: 'reconciliation',
  baseline: true,
  description: 'Our internal refund record(s) for this order, if any: status and amount.',
  run(state) {
    const s = state.order;
    if (!s) return [];
    return s.refunds.map((r) => ({
      source: 'getRefund',
      system: 'REFUND' as const,
      entityRef: r.id,
      facts: { status: r.status, amountMinor: r.amountMinor, gwRefundId: r.gwRefundId ?? 'none' },
      observedAt: r.updatedAt.toISOString(),
    }));
  },
};

const getRefundGatewayStatus: ToolDef = {
  name: 'getRefundGatewayStatus',
  group: 'reconciliation',
  baseline: false,
  description: 'What the gateway says about each refund: status and when it was processed.',
  run(state) {
    const s = state.order;
    if (!s) return [];
    return s.gwRefunds.map((r) => ({
      source: 'getRefundGatewayStatus',
      system: 'REFUND' as const,
      entityRef: r.id,
      facts: { status: r.status, amountMinor: r.amountMinor, processedAt: r.processedAt ? r.processedAt.toISOString() : 'not processed' },
      observedAt: r.createdAt.toISOString(),
    }));
  },
};

const getSettlementLines: ToolDef = {
  name: 'getSettlementLines',
  group: 'reconciliation',
  baseline: false,
  description: 'Settlement lines for this batch: gross, fee and net per payment, and the line number.',
  run(state) {
    const b = state.batch;
    if (!b) return [];
    return b.data.lines.map((l) => ({
      source: 'getSettlementLines',
      system: 'SETTLEMENT' as const,
      entityRef: l.id,
      facts: { grossMinor: l.grossMinor, feeMinor: l.feeMinor, netMinor: l.netMinor, lineNo: l.lineNo },
      observedAt: l.settledOn.toISOString(),
    }));
  },
};

const getFeeBreakdown: ToolDef = {
  name: 'getFeeBreakdown',
  group: 'reconciliation',
  baseline: false,
  description: "The settlement batch's totals against the ledger: expected net, actual net and the difference.",
  run(state) {
    const b = state.batch;
    if (!b) return [];
    return [
      {
        source: 'getFeeBreakdown',
        system: 'SETTLEMENT' as const,
        entityRef: b.data.settlement.id,
        facts: {
          expectedNetMinor: b.check.expectedNetMinor,
          reportedNetMinor: b.check.reportedNetMinor,
          diffMinor: b.check.diffMinor,
          matched: b.check.diffMinor === 0,
          summary: `expected ${formatMoney(b.check.expectedNetMinor)}, reported ${formatMoney(b.check.reportedNetMinor)}`,
        },
        observedAt: b.data.settlement.updatedAt.toISOString(),
      },
    ];
  },
};

export const PAYMENT_TOOLS: ToolDef[] = [getInternalPayment, getGatewayPayment, getOrder, getOrderTimeline, getWebhookDeliveries, getPaymentAttempts];
export const RECONCILIATION_TOOLS: ToolDef[] = [getLedgerEntries, getRefund, getRefundGatewayStatus, getSettlementLines, getFeeBreakdown];
export const ALL_TOOLS: ToolDef[] = [...PAYMENT_TOOLS, ...RECONCILIATION_TOOLS];

export const BASELINE_TOOLS = ALL_TOOLS.filter((t) => t.baseline);
export const FOLLOWUP_TOOLS = ALL_TOOLS.filter((t) => !t.baseline);
