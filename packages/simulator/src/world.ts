/**
 * Base data every scenario draws from: merchants with fee contracts, customers and their devices.
 * Ids come from a fixed seed, and inserts use ON CONFLICT DO NOTHING, so seeding is idempotent.
 */
import { DAY_MS, maskEmail, maskPhone, seededIds } from '@payops/shared';
import { tables, type DbOrTx } from '@payops/core';

export type MerchantKey = 'kavya' | 'northwind' | 'tandem';

export interface WorldMerchant {
  key: MerchantKey;
  id: string;
  name: string;
  feeBps: number;
  taxBps: number;
  feeFixedMinor: number;
}

export interface WorldCustomer {
  id: string;
  name: string;
  deviceId: string;
  homeCountry: string;
}

export interface World {
  merchants: Record<MerchantKey, WorldMerchant>;
  customers: WorldCustomer[];
}

const MERCHANTS: ReadonlyArray<Omit<WorldMerchant, 'id' | 'taxBps' | 'feeFixedMinor'>> = [
  { key: 'kavya', name: 'Kavya Electronics', feeBps: 200 },
  { key: 'northwind', name: 'Northwind Grocers', feeBps: 180 },
  { key: 'tandem', name: 'Tandem Travel', feeBps: 220 },
];

const CUSTOMER_NAMES = [
  'Aarav Sharma', 'Priya Iyer', 'Rohan Mehta', 'Ananya Reddy', 'Vikram Nair', 'Sneha Kulkarni',
  'Arjun Patel', 'Kavya Menon', 'Ishaan Gupta', 'Meera Pillai', 'Aditya Joshi', 'Diya Banerjee',
  'Karthik Subramanian', 'Neha Deshpande', 'Rahul Verma', 'Pooja Chatterjee', 'Siddharth Rao',
  'Tanvi Shetty', 'Nikhil Agarwal', 'Riya Kapoor', 'Varun Hegde', 'Aisha Khan', 'Manish Tiwari',
  'Lakshmi Krishnan',
] as const;

const EMAIL_DOMAINS = ['gmail.com', 'outlook.com', 'yahoo.co.in', 'rediffmail.com'] as const;

/** The world's ids and names are a pure function of the fixed seed. */
function buildWorld(): World & {
  customerRows: Array<{ id: string; name: string; email: string; phone: string; ageDays: number; deviceId: string; fingerprint: string }>;
} {
  const gen = seededIds('world');
  const merchants = Object.fromEntries(
    MERCHANTS.map((m) => [m.key, { ...m, id: gen.next('merchant'), taxBps: 1800, feeFixedMinor: 0 }]),
  ) as Record<MerchantKey, WorldMerchant>;
  const customerRows = CUSTOMER_NAMES.map((name) => {
    const [first = '', last = ''] = name.toLowerCase().split(' ');
    return {
      id: gen.next('customer'),
      name,
      email: `${first}.${last}${gen.int(1, 99)}@${gen.pick(EMAIL_DOMAINS)}`,
      phone: `+91 9${gen.int(100_000_000, 999_999_999)}`,
      ageDays: gen.int(30, 900),
      deviceId: gen.next('device'),
      fingerprint: `fp_${gen.int(1_000_000, 9_999_999).toString(16)}`,
    };
  });
  return {
    merchants,
    customers: customerRows.map((c) => ({ id: c.id, name: c.name, deviceId: c.deviceId, homeCountry: 'IN' })),
    customerRows,
  };
}

const BUILT = buildWorld();
export const WORLD: World = { merchants: BUILT.merchants, customers: BUILT.customers };

/** Inserts merchants, customers and devices if missing. Safe to call on every generate. */
export async function seedWorld(db: DbOrTx, now: Date): Promise<World> {
  const at = (days: number) => new Date(now.getTime() - days * DAY_MS);
  await db
    .insert(tables.merchants)
    .values(
      Object.values(WORLD.merchants).map((m) => ({
        id: m.id,
        name: m.name,
        feeBps: m.feeBps,
        feeFixedMinor: m.feeFixedMinor,
        taxBps: m.taxBps,
        settlementCycleDays: 1,
        createdAt: at(1200),
        updatedAt: at(1200),
      })),
    )
    .onConflictDoNothing();
  await db
    .insert(tables.customers)
    .values(
      BUILT.customerRows.map((c) => ({
        id: c.id,
        name: c.name,
        emailMasked: maskEmail(c.email),
        phoneMasked: maskPhone(c.phone),
        riskFlags: [],
        createdAt: at(c.ageDays),
        updatedAt: at(c.ageDays),
      })),
    )
    .onConflictDoNothing();
  await db
    .insert(tables.devices)
    .values(
      BUILT.customerRows.map((c) => ({
        id: c.deviceId,
        customerId: c.id,
        fingerprint: c.fingerprint,
        ipCountry: 'IN',
        firstSeenAt: at(c.ageDays),
      })),
    )
    .onConflictDoNothing();
  return WORLD;
}
