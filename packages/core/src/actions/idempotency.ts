import { createHash } from 'node:crypto';
import type { CatalogAction } from '@payops/shared';

/** JSON with object keys sorted at every level, so equal params always serialise the same way. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * One key per (resolution, step, action): executing the same resolution again finds the stored
 * execution instead of acting twice.
 */
export function idempotencyKey(resolutionId: string, index: number, action: CatalogAction): string {
  return createHash('sha256').update(`${resolutionId}|${index}|${action.type}|${stableJson(action.params)}`).digest('hex');
}
