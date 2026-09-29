/**
 * Contract tests for PaymentGatewayPort. Every gateway adapter (simulator today, Razorpay or
 * PayPal test mode later) runs this same suite, so "works like a gateway" means one thing.
 * The suite only uses the port, never an adapter's internals or tables.
 *
 * To test a new adapter, call `describeGatewayContract` from a test file and give it a setup
 * function that returns a gateway plus the ids of one captured payment it can read.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { PaymentGatewayPort } from '../ports/gateway';

export interface GatewayContractFixture {
  gateway: PaymentGatewayPort;
  /** A CAPTURED payment with nothing refunded yet, whose webhook was delivered at least once. */
  gwPaymentId: string;
  /** Set when that payment already appears in a settlement file. */
  settled: boolean;
}

export interface GatewayContractOptions {
  /** Runs before every test. Return fresh state, because createRefund changes the gateway. */
  setup: () => Promise<GatewayContractFixture>;
}

const MISSING = 'gw_contract_does_not_exist';

export function describeGatewayContract(adapterName: string, { setup }: GatewayContractOptions): void {
  describe(`PaymentGatewayPort contract: ${adapterName}`, () => {
    let f: GatewayContractFixture;
    beforeEach(async () => {
      f = await setup();
    });

    describe('identity', () => {
      it('has a non-empty name', () => {
        expect(f.gateway.name.length).toBeGreaterThan(0);
      });
    });

    describe('reading payments', () => {
      it('returns nothing for an empty id list', async () => {
        expect(await f.gateway.getPayments([])).toEqual([]);
        expect(await f.gateway.listPaymentsByOrder([])).toEqual([]);
      });

      it('returns a captured payment with integer paise amounts and real dates', async () => {
        const [p] = await f.gateway.getPayments([f.gwPaymentId]);
        expect(p).toBeDefined();
        expect(p!.id).toBe(f.gwPaymentId);
        expect(p!.status).toBe('CAPTURED');
        expect(Number.isInteger(p!.amountMinor)).toBe(true);
        expect(p!.amountMinor).toBeGreaterThan(0);
        expect(p!.refundedMinor).toBe(0);
        expect(p!.capturedAt).toBeInstanceOf(Date);
        expect(p!.createdAt).toBeInstanceOf(Date);
      });

      it('leaves unknown ids out instead of throwing', async () => {
        const found = await f.gateway.getPayments([f.gwPaymentId, MISSING]);
        expect(found.map((p) => p.id)).toEqual([f.gwPaymentId]);
        expect(await f.gateway.getPayments([MISSING])).toEqual([]);
      });

      it('finds the same payment by its order reference', async () => {
        const [p] = await f.gateway.getPayments([f.gwPaymentId]);
        const byOrder = await f.gateway.listPaymentsByOrder([p!.orderRef]);
        expect(byOrder.map((x) => x.id)).toContain(f.gwPaymentId);
        expect(await f.gateway.listPaymentsByOrder([MISSING])).toEqual([]);
      });
    });

    describe('webhook deliveries', () => {
      it('lists the deliveries of a payment with their attempts', async () => {
        const deliveries = await f.gateway.listWebhookDeliveries([f.gwPaymentId]);
        expect(deliveries.length).toBeGreaterThan(0);
        for (const d of deliveries) {
          expect(d.gwPaymentId).toBe(f.gwPaymentId);
          expect(d.createdAt).toBeInstanceOf(Date);
          expect(Array.isArray(d.attempts)).toBe(true);
        }
      });

      it('returns nothing for an empty or unknown payment list', async () => {
        expect(await f.gateway.listWebhookDeliveries([])).toEqual([]);
        expect(await f.gateway.listWebhookDeliveries([MISSING])).toEqual([]);
      });

      it('replays a known event and reports what our consumer answered', async () => {
        const [d] = await f.gateway.listWebhookDeliveries([f.gwPaymentId]);
        const result = await f.gateway.replayWebhook(d!.id);
        expect(result.httpStatus === null || Number.isInteger(result.httpStatus)).toBe(true);
        expect(Number.isNaN(new Date(result.attemptAt).getTime())).toBe(false);
      });

      it('rejects a replay of an unknown event', async () => {
        await expect(f.gateway.replayWebhook(MISSING)).rejects.toThrow();
      });
    });

    describe('settlement', () => {
      it('returns nothing without a filter', async () => {
        expect(await f.gateway.listSettlementLines({})).toEqual([]);
      });

      it('returns lines whose net is gross minus fee and tax, all in integer paise', async () => {
        const lines = await f.gateway.listSettlementLines({ gwPaymentIds: [f.gwPaymentId] });
        if (!f.settled) {
          expect(lines).toEqual([]);
          return;
        }
        expect(lines.length).toBeGreaterThan(0);
        for (const l of lines) {
          for (const n of [l.grossMinor, l.feeMinor, l.taxMinor, l.netMinor]) expect(Number.isInteger(n)).toBe(true);
          expect(l.netMinor).toBe(l.grossMinor - l.feeMinor - l.taxMinor);
          expect(l.settledOn).toBeInstanceOf(Date);
        }
        const byBatch = await f.gateway.listSettlementLines({ batchIds: [lines[0]!.batchId] });
        expect(byBatch.map((l) => l.id)).toContain(lines[0]!.id);
      });
    });

    describe('capture summary', () => {
      it('counts a capture inside [from, to) and not one at the upper bound', async () => {
        const [p] = await f.gateway.getPayments([f.gwPaymentId]);
        const at = p!.capturedAt!;
        const inside = await f.gateway.summarizeCaptures({ from: at, to: new Date(at.getTime() + 1) });
        expect(inside.count).toBeGreaterThanOrEqual(1);
        expect(inside.amountMinor).toBeGreaterThanOrEqual(p!.amountMinor);
        const atUpperBound = await f.gateway.summarizeCaptures({ from: new Date(at.getTime() - 1000), to: at });
        expect(atUpperBound.count).toBe(0);
      });

      it('returns zero for a range with no captures', async () => {
        expect(await f.gateway.summarizeCaptures({ from: new Date(0), to: new Date(1000) })).toEqual({
          count: 0,
          amountMinor: 0,
        });
      });
    });

    describe('refunds', () => {
      it('has no refunds before one is created', async () => {
        expect(await f.gateway.listRefunds([f.gwPaymentId])).toEqual([]);
        expect(await f.gateway.listRefunds([])).toEqual([]);
      });

      it('creates a partial refund and reflects it on the payment', async () => {
        const [before] = await f.gateway.getPayments([f.gwPaymentId]);
        const amountMinor = Math.floor(before!.amountMinor / 2);
        const refund = await f.gateway.createRefund({ gwPaymentId: f.gwPaymentId, amountMinor });
        expect(refund.gwPaymentId).toBe(f.gwPaymentId);
        expect(refund.amountMinor).toBe(amountMinor);
        expect(['PENDING', 'PROCESSED']).toContain(refund.status);

        const [after] = await f.gateway.getPayments([f.gwPaymentId]);
        expect(after!.refundedMinor).toBe(amountMinor);
        expect(after!.status).toBe('PARTIALLY_REFUNDED');
        const listed = await f.gateway.listRefunds([f.gwPaymentId]);
        expect(listed.map((r) => r.id)).toEqual([refund.id]);
      });

      it('refunds the full amount once, then refuses any more', async () => {
        const [p] = await f.gateway.getPayments([f.gwPaymentId]);
        await f.gateway.createRefund({ gwPaymentId: f.gwPaymentId, amountMinor: p!.amountMinor });
        const [after] = await f.gateway.getPayments([f.gwPaymentId]);
        expect(after!.status).toBe('REFUNDED');
        await expect(f.gateway.createRefund({ gwPaymentId: f.gwPaymentId, amountMinor: 1 })).rejects.toThrow();
      });

      it('refuses an amount above the refundable balance and changes nothing', async () => {
        const [p] = await f.gateway.getPayments([f.gwPaymentId]);
        await expect(
          f.gateway.createRefund({ gwPaymentId: f.gwPaymentId, amountMinor: p!.amountMinor + 1 }),
        ).rejects.toThrow();
        const [after] = await f.gateway.getPayments([f.gwPaymentId]);
        expect(after!.refundedMinor).toBe(0);
        expect(await f.gateway.listRefunds([f.gwPaymentId])).toEqual([]);
      });

      it('refuses zero and negative amounts', async () => {
        await expect(f.gateway.createRefund({ gwPaymentId: f.gwPaymentId, amountMinor: 0 })).rejects.toThrow();
        await expect(f.gateway.createRefund({ gwPaymentId: f.gwPaymentId, amountMinor: -100 })).rejects.toThrow();
      });

      it('refuses a refund on an unknown payment', async () => {
        await expect(f.gateway.createRefund({ gwPaymentId: MISSING, amountMinor: 100 })).rejects.toThrow();
      });
    });
  });
}
