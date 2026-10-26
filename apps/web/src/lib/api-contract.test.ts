// @vitest-environment node
/**
 * Contract check: every API call the web app makes exists in the backend's committed OpenAPI snapshot, with the same method.
 *
 * The snapshot is `python/payops/tests/contract/openapi.json`. The backend has its own test that fails when the API stops matching it,
 * so the two tests together make a renamed or removed route, or a changed method, fail CI on whichever side moved first.
 * Response shapes are guarded on the backend (the snapshot test and the recorded-response contract tests).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Spec {
  paths: Record<string, Record<string, unknown>>;
}

const SRC = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('../../../../python/payops/tests/contract/openapi.json', import.meta.url));

/** Template literal and query parts reduced to the OpenAPI path form: `/api/cases/{}/runs`. */
export function normalise(raw: string): string {
  return raw
    .replace(/\$\{toQueryString[\s\S]*$/, '')
    .replace(/\$\{[^}]*\}/g, '{}')
    .replace(/\?.*$/, '');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'mocks' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

interface Call {
  file: string;
  method: string;
  path: string;
}

/** Finds `'/api/...'` and `` `/api/...` `` literals and works out the HTTP method from the code around them. */
export function findCalls(file: string, text: string): Call[] {
  const calls: Call[] = [];
  const re = /(['`])(\/api\/[^'`]*)\1/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    const after = text.slice(m.index, m.index + 260);
    const explicit = /method:\s*'(GET|POST|PUT|PATCH|DELETE)'/.exec(after);
    const helper = /\b(post|put|patch|usePasswordStep)\s*(<[^>]*>)?\(\s*$/.exec(before) ?? /\busePasswordStep<[^>]*>\(\s*$/.exec(before);
    const method = explicit?.[1] ?? (helper ? 'POST' : 'GET');
    calls.push({ file, method, path: normalise(m[2]!) });
  }
  return calls;
}

function matches(specPath: string, callPath: string): boolean {
  const pattern = new RegExp(`^${specPath.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+')}$`);
  return pattern.test(callPath.replace(/\{\}/g, 'x'));
}

describe('the web app calls only routes the backend contract has', () => {
  const spec = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Spec;
  const calls = sourceFiles(SRC).flatMap((file) => findCalls(file.replace(SRC, ''), readFileSync(file, 'utf8')));

  it('finds the calls (so this test cannot pass by scanning nothing)', () => {
    expect(calls.length).toBeGreaterThan(25);
  });

  it('every call has a matching operation with the same method', () => {
    const missing = calls
      .filter((c) => !Object.entries(spec.paths).some(([p, ops]) => matches(p, c.path) && c.method.toLowerCase() in ops))
      .map((c) => `${c.method} ${c.path}  (${c.file})`);
    expect(missing, `Not in the API contract:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('reads the method from the code around a call', () => {
    expect(findCalls('x', "api<T>('/api/a', { method: 'PUT', body })")[0]!.method).toBe('PUT');
    expect(findCalls('x', "post<T>('/api/b')")[0]!.method).toBe('POST');
    expect(findCalls('x', 'api<T>(`/api/c/${id}?x=1`)')[0]).toMatchObject({ method: 'GET', path: '/api/c/{}' });
    expect(normalise('/api/runs${toQueryString({ caseId, limit: 100 })}')).toBe('/api/runs');
  });
});
