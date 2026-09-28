/**
 * Prefixed, human-scannable identifiers (docs/02-architecture.md §6).
 * Random ids use crypto; seeded ids use a deterministic PRNG so simulator output
 * (and therefore recorded model prompts) is reproducible.
 */

export const ID_PREFIX = {
  payment: 'pay',
  gwPayment: 'gwp',
  order: 'ord',
  refund: 'rfd',
  gwRefund: 'gwr',
  ledgerEntry: 'led',
  settlementBatch: 'stb',
  merchant: 'mer',
  customer: 'cus',
  device: 'dev',
  webhookEvent: 'evt',
  attempt: 'att',
  case: 'case',
  run: 'run',
  user: 'usr',
  note: 'note',
  dispute: 'dsp',
  execution: 'exe',
  approval: 'apr',
  audit: 'aud',
  journal: 'jrn',
  settlementLine: 'sln',
  resolution: 'rsl',
  validation: 'val',
  agentStep: 'ast',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish, no i/l/o/u

/** Mulberry32: tiny deterministic PRNG. Good enough for fixtures, not for secrets. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function randomChars(len: number, next: () => number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return out;
}

const cryptoNext = (): number => {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return (buf[0] ?? 0) / 4294967296;
};

export function newId(kind: IdKind, len = 14): string {
  return `${ID_PREFIX[kind]}_${randomChars(len, cryptoNext)}`;
}

export interface IdGenerator {
  next(kind: IdKind): string;
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  float(): number;
}

/** Deterministic id + value generator for the simulator and tests. */
export function seededIds(seed: number | string): IdGenerator {
  const rng = mulberry32(typeof seed === 'string' ? hashSeed(seed) : seed);
  return {
    next: (kind) => `${ID_PREFIX[kind]}_${randomChars(14, rng)}`,
    int: (min, max) => min + Math.floor(rng() * (max - min + 1)),
    pick: (items) => {
      if (items.length === 0) throw new Error('pick() on empty list');
      return items[Math.floor(rng() * items.length)] as (typeof items)[number];
    },
    float: rng,
  };
}

/** Case display ids look like PAY-8291 / RFD-1042 / STL-3310 / RSK-0932 / DUP-5521. */
export function caseDisplayId(prefix: 'PAY' | 'RFD' | 'STL' | 'RSK' | 'DUP', seq: number): string {
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}
