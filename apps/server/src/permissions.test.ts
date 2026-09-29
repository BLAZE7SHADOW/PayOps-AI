import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Router } from 'express';
import { PERMISSIONS, permissionTableMarkdown, type Permission } from '@payops/shared';
import { GUARD } from './auth/middleware';
import { buildRouter } from './routes';

/**
 * A route without a declared guard is the classic way an endpoint ends up open by accident.
 * This walks every route in the real router and fails if one has neither requirePermission
 * nor an explicit publicRoute() marker, either on the route or on a router.use() above it.
 */
interface Layer {
  handle: { stack?: Layer[]; [GUARD]?: Permission | 'public' };
  route?: { path: string; methods: Record<string, boolean>; stack: Layer[] };
}

interface Found {
  route: string;
  guard: Permission | 'public' | undefined;
}

function walk(stack: Layer[], inherited: Found['guard'], prefix: string, out: Found[]): void {
  let guard = inherited;
  for (const layer of stack) {
    if (layer.route) {
      const own = layer.route.stack.map((l) => l.handle[GUARD]).find((g) => g !== undefined);
      const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
      out.push({ route: `${methods} ${prefix}${layer.route.path}`, guard: own ?? guard });
    } else if (layer.handle.stack) {
      walk(layer.handle.stack, guard, `${prefix}(router) `, out);
    } else if (layer.handle[GUARD] !== undefined) {
      guard = layer.handle[GUARD];
    }
  }
}

function collect(): Found[] {
  const stub = {} as never;
  // Routes only read these when a request arrives, so stubs are enough to build the real router.
  const core = { db: {} } as never;
  const session = { key: new Uint8Array(32) } as never;
  const router = buildRouter({ database: stub, core, boss: stub, env: { DEMO_MODE: false } as never, session, sessions: stub, limiter: stub });
  const out: Found[] = [];
  walk((router as unknown as Router & { stack: Layer[] }).stack, undefined, '', out);
  return out;
}

describe('route guards', () => {
  const found = collect();

  it('finds the routes', () => {
    expect(found.length).toBeGreaterThan(40);
  });

  it('every route names a permission or is explicitly public', () => {
    const unguarded = found.filter((f) => f.guard === undefined).map((f) => f.route);
    expect(unguarded).toEqual([]);
  });

  it('every permission in the table guards at least one route', () => {
    const used = new Set(found.map((f) => f.guard));
    const unused = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => !used.has(p));
    expect(unused).toEqual([]);
  });

  it('only sign-in, session lookup and health are public', () => {
    const open = found.filter((f) => f.guard === 'public').map((f) => f.route).sort();
    expect(open).toHaveLength(7);
  });
});

describe('permission docs', () => {
  it('docs/02-architecture.md matches the permission table', () => {
    const doc = readFileSync(join(__dirname, '../../../docs/02-architecture.md'), 'utf8');
    const match = /<!-- permissions:start -->\n([\s\S]*?)\n<!-- permissions:end -->/.exec(doc);
    expect(match, 'permissions markers missing in docs/02-architecture.md').not.toBeNull();
    expect(match![1]).toBe(permissionTableMarkdown());
  });
});
