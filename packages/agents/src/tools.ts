/**
 * Payment, Reconciliation and Risk tool groups (docs/03-agent-system.md §9), one group per
 * specialist agent (nodes.ts: `paymentAgent`/`reconciliationAgent`/`riskAgent`). The grouping is
 * what makes the "never contains" rule (§3/§8) real: each specialist's follow-up LLM call can
 * only pick from its own group's tools, so it can never call another agent's tool.
 *
 * Each tool is a pure projector over the case's already-loaded `CaseState` (docs/02 §4.2: the
 * gateway and database were already read once by `loadCase`; tools never touch them again).
 * There are no write tools here — writes only happen in the executor.
 */
import type { CaseState } from '@payops/core';
import { DAY_MS, formatMoney } from '@payops/shared';
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
  group: 'payment' | 'reconciliation' | 'risk';
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
  baseline: true,
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
  baseline: true,
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

// ── Risk (docs/03 §9 "Risk"): all four run as baseline, unlike Payment/Reconciliation ──────────
// (docs/DECISIONS.md): J3 (docs/03 §4) feeds Jev a fixed bucketed `state` object built from all
// four signals at once — there is no LLM tool-choice step to bound, so there is nothing for a
// follow-up subset to gate. `RISK_FOLLOWUP_TOOLS` stays empty (below), not because Risk has no
// tools, but because it never runs a second, narrower pass the way Payment/Reconciliation do.

const getCustomerHistory: ToolDef = {
  name: 'getCustomerHistory',
  group: 'risk',
  baseline: true,
  description: "The customer's account: how long ago it was created, and any risk flags recorded on it.",
  run(state) {
    const s = state.order;
    if (!s) return [];
    const c = s.customer;
    const accountAgeDays = Math.round(((state.now.getTime() - c.createdAt.getTime()) / DAY_MS) * 100) / 100;
    return [
      {
        source: 'getCustomerHistory',
        system: 'RISK',
        entityRef: c.id,
        facts: {
          accountAgeDays: Math.max(0, accountAgeDays),
          riskFlagsCount: c.riskFlags.length,
          riskFlags: c.riskFlags.length ? c.riskFlags.join(',') : 'none',
        },
        observedAt: iso(c.createdAt),
      },
    ];
  },
};

const getDeviceSignals: ToolDef = {
  name: 'getDeviceSignals',
  group: 'risk',
  baseline: true,
  description: 'Distinct devices and card countries seen on the recent attempts, and whether the device location matches the card country.',
  run(state) {
    const s = state.order;
    if (!s) return [];
    const cardCountries = new Set(s.recentAttempts.map((a) => a.cardCountry).filter((c): c is string => Boolean(c)));
    const deviceIds = new Set(s.recentAttempts.map((a) => a.deviceId));
    const latest = s.recentAttempts.at(-1);
    const latestDevice = latest ? s.devices.find((d) => d.id === latest.deviceId) : undefined;
    const mismatch = Boolean(latest?.cardCountry && latestDevice && latest.cardCountry !== latestDevice.ipCountry);
    return [
      {
        source: 'getDeviceSignals',
        system: 'RISK',
        entityRef: s.customer.id,
        facts: {
          deviceCount: deviceIds.size,
          cardCountriesDistinct: cardCountries.size,
          primaryIpCountry: latestDevice?.ipCountry ?? 'unknown',
          ipCardCountryMismatch: mismatch,
        },
        observedAt: iso(latest?.at),
      },
    ];
  },
};

const getFailedAttempts: ToolDef = {
  name: 'getFailedAttempts',
  group: 'risk',
  baseline: true,
  description: 'How many of the recent payment attempts failed, out of how many total, in the risk window before capture.',
  run(state) {
    const s = state.order;
    if (!s) return [];
    const failed = s.recentAttempts.filter((a) => a.result === 'FAILED').length;
    return [
      {
        source: 'getFailedAttempts',
        system: 'RISK',
        entityRef: s.customer.id,
        facts: { failed24h: failed, total24h: s.recentAttempts.length },
        observedAt: iso(s.recentAttempts.at(-1)?.at),
      },
    ];
  },
};

const getChargebackHistory: ToolDef = {
  name: 'getChargebackHistory',
  group: 'risk',
  baseline: true,
  description:
    "Settlement disputes raised against this order's merchant recently. This schema does not yet track chargebacks per customer " +
    '(docs/DECISIONS.md), so this is the merchant-level exposure proxy, not the customer\'s own chargeback history.',
  run(state) {
    const s = state.order;
    if (!s) return [];
    return [
      {
        source: 'getChargebackHistory',
        system: 'RISK',
        entityRef: s.merchant.id,
        facts: {
          merchantDisputeCount: s.merchantDisputes.length,
          note: 'merchant-level settlement disputes, not customer-level chargebacks',
        },
        observedAt: iso(s.merchantDisputes.at(-1)?.updatedAt),
      },
    ];
  },
};

export const PAYMENT_TOOLS: ToolDef[] = [getInternalPayment, getGatewayPayment, getOrder, getOrderTimeline, getWebhookDeliveries, getPaymentAttempts];
export const RECONCILIATION_TOOLS: ToolDef[] = [getLedgerEntries, getRefund, getRefundGatewayStatus, getSettlementLines, getFeeBreakdown];
export const RISK_TOOLS: ToolDef[] = [getCustomerHistory, getDeviceSignals, getFailedAttempts, getChargebackHistory];
export const ALL_TOOLS: ToolDef[] = [...PAYMENT_TOOLS, ...RECONCILIATION_TOOLS, ...RISK_TOOLS];

export const BASELINE_TOOLS = ALL_TOOLS.filter((t) => t.baseline);
export const FOLLOWUP_TOOLS = ALL_TOOLS.filter((t) => !t.baseline);

/** Per-specialist follow-up subsets (docs/03 §2 "investigative pass"): each specialist's `plan`
 * fan-out node may only pick from its own group, so it can never call another agent's tools. */
export const PAYMENT_FOLLOWUP_TOOLS = PAYMENT_TOOLS.filter((t) => !t.baseline);
export const RECONCILIATION_FOLLOWUP_TOOLS = RECONCILIATION_TOOLS.filter((t) => !t.baseline);
/** Empty: every risk tool is baseline (see the header comment above), so Risk never runs a
 * follow-up LLM tool-choice pass the way Payment/Reconciliation do. */
export const RISK_FOLLOWUP_TOOLS: ToolDef[] = RISK_TOOLS.filter((t) => !t.baseline);
