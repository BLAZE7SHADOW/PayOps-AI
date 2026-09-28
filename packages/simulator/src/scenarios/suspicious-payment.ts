import { maskEmail, maskPhone } from '@payops/shared';
import { tables } from '@payops/core';
import { checkout } from '../checkout';
import { HOUR, MIN, before, type ScenarioWriter } from './types';

const FAILURE_CODES = ['CARD_DECLINED', 'INSUFFICIENT_FUNDS', 'DO_NOT_HONOR', 'CVV_MISMATCH'] as const;
const CARD_COUNTRIES = ['IN', 'US', 'GB'] as const;

/**
 * A 2-hour-old account makes 8 failed attempts across 3 card countries within an hour, then a
 * ₹45,000 payment succeeds. Every system agrees; the only signal is behaviour.
 */
export const suspiciousPayment: ScenarioWriter = async (ctx) => {
  const { tx, ids } = ctx;
  const createdAt = before(ctx, 2 * HOUR);
  const customerId = ids.next('customer');
  const deviceId = ids.next('device');
  await tx.insert(tables.customers).values({
    id: customerId,
    name: 'Rakesh Malhotra',
    emailMasked: maskEmail(`rk.m${ids.int(1000, 9999)}@protonmail.com`),
    phoneMasked: maskPhone(`+91 7${ids.int(100_000_000, 999_999_999)}`),
    riskFlags: [],
    createdAt,
    updatedAt: createdAt,
  });
  await tx.insert(tables.devices).values({
    id: deviceId,
    customerId,
    fingerprint: `fp_${ids.int(1_000_000, 9_999_999).toString(16)}`,
    ipCountry: 'SG',
    firstSeenAt: createdAt,
  });

  const amountMinor = 4_500_000;
  const firstAttempt = before(ctx, 60 * MIN);
  await tx.insert(tables.paymentAttempts).values(
    Array.from({ length: 8 }, (_, i) => ({
      id: ids.next('attempt'),
      customerId,
      deviceId,
      orderId: null,
      amountMinor,
      result: 'FAILED' as const,
      failureCode: FAILURE_CODES[i % FAILURE_CODES.length] ?? 'CARD_DECLINED',
      cardCountry: CARD_COUNTRIES[i % CARD_COUNTRIES.length] ?? 'IN',
      at: new Date(firstAttempt.getTime() + i * 6 * MIN),
    })),
  );

  await checkout(ctx, {
    amountMinor,
    at: before(ctx, 10 * MIN),
    customer: { id: customerId, name: 'Rakesh Malhotra', deviceId, homeCountry: 'IN' },
    merchant: ctx.world.merchants.kavya,
    card: { network: 'MASTERCARD', country: 'GB', last4: '8830' },
    deviceId,
  });
};
