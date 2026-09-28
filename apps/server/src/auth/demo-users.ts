/**
 * Seeded demo accounts. Idempotent: existing emails are left alone. All use DEMO_PASSWORD.
 */
import { inArray } from 'drizzle-orm';
import { seededIds, type DemoAccount, type Role } from '@payops/shared';
import { tables, type Db } from '@payops/core';
import { hashPassword } from './password';

export const DEMO_PASSWORD = 'payops-demo';

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { email: 'ops@payops.dev', name: 'Ananya Rao', role: 'OPS', label: 'Ops analyst' },
  { email: 'ops2@payops.dev', name: 'Rahul Menon', role: 'OPS', label: 'Second ops analyst' },
  { email: 'manager@payops.dev', name: 'Meera Iyer', role: 'MANAGER', label: 'Ops manager' },
  { email: 'viewer@payops.dev', name: 'Kabir Shah', role: 'VIEWER', label: 'Viewer' },
  { email: 'admin@payops.dev', name: 'Admin', role: 'ADMIN', label: 'Admin' },
];

const ids = seededIds('demo-users');
const DEMO_IDS = new Map(DEMO_ACCOUNTS.map((a) => [a.email, ids.next('user')]));

export function isDemoEmail(email: string): boolean {
  return DEMO_IDS.has(email);
}

/** Inserts missing demo users. Returns how many were created. */
export async function seedDemoUsers(db: Db): Promise<number> {
  const existing = await db
    .select({ email: tables.users.email })
    .from(tables.users)
    .where(inArray(tables.users.email, DEMO_ACCOUNTS.map((a) => a.email)));
  const have = new Set(existing.map((e) => e.email));
  const missing = DEMO_ACCOUNTS.filter((a) => !have.has(a.email));
  if (missing.length === 0) return 0;
  const rows = await Promise.all(
    missing.map(async (a) => ({
      id: DEMO_IDS.get(a.email) as string,
      email: a.email,
      name: a.name,
      role: a.role as Role,
      passwordHash: await hashPassword(DEMO_PASSWORD),
    })),
  );
  await db.insert(tables.users).values(rows).onConflictDoNothing();
  return rows.length;
}
