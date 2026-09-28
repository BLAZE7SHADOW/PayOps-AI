/**
 * Cassette format for RECORD/REPLAY (docs/03-agent-system.md §14). Only model responses
 * (LLM and Jev) are recorded; the graph, tools, database, policy, executor and validator
 * always run for real. One JSONL file per scenario key under `fixtures/cassettes/`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CASSETTE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/cassettes');

export interface CassetteEntry {
  key: string;
  kind: 'llm' | 'jev';
  /** For humans reading the file; never used to look the entry up. */
  meta: Record<string, unknown>;
  response: unknown;
}

export class ReplayMissError extends Error {
  constructor(public readonly key: string, public readonly kind: 'llm' | 'jev') {
    super(`REPLAY miss: no recorded ${kind} response for cassette key ${key}`);
    this.name = 'ReplayMissError';
  }
}

/** Deterministic hash of a JSON-serialisable value: sorts object keys so field order never matters. */
export function stableHash(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = normalize((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

/** `hash(node, callIndexInNode, normalizedPromptHash)` (docs/03 §14). */
export function cassetteKey(node: string, callIndexInNode: number, normalizedPromptHash: string): string {
  return createHash('sha256').update(`${node}|${callIndexInNode}|${normalizedPromptHash}`).digest('hex').slice(0, 24);
}

export function cassettePath(scenarioKey: string, dir: string = DEFAULT_CASSETTE_DIR): string {
  return join(dir, `${scenarioKey}.jsonl`);
}

/**
 * Reads a scenario's cassette once, keyed for O(1) lookup; entries with the same key queue up
 * (in file order) so repeated identical calls within a run each get their own recorded response.
 */
export class CassetteReader {
  private queues: Map<string, unknown[]> | null = null;

  constructor(private readonly path: string) {}

  private async load(): Promise<Map<string, unknown[]>> {
    if (this.queues) return this.queues;
    const queues = new Map<string, unknown[]>();
    if (existsSync(this.path)) {
      const text = await readFile(this.path, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as CassetteEntry;
        const q = queues.get(entry.key) ?? [];
        q.push(entry.response);
        queues.set(entry.key, q);
      }
    }
    this.queues = queues;
    return queues;
  }

  async read(key: string, kind: 'llm' | 'jev'): Promise<unknown> {
    const queues = await this.load();
    const q = queues.get(key);
    if (!q || q.length === 0) throw new ReplayMissError(key, kind);
    return q.shift();
  }
}

/** Appends one recorded call. Safe to call concurrently: each call is one atomic line append. */
export async function appendCassette(path: string, entry: CassetteEntry): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}
