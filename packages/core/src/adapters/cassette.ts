/**
 * Cassette format for RECORD/REPLAY (docs/03-agent-system.md §14). Only model responses
 * (LLM and Jev) are recorded; the graph, tools, database, policy, executor and validator
 * always run for real. One JSONL file per scenario key under `fixtures/cassettes/`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
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
 * Files REPLAY reads for a scenario key. Runs started without a scenario use the key 'default'
 * (D032); when no `default.jsonl` was recorded, they read every scenario cassette instead.
 * Lookup is by content hash (`cassetteKey`), so a run only ever gets a response recorded for the
 * same prompt, and unrelated scenarios cannot answer each other's calls (docs/DECISIONS.md D053).
 */
export function replayCassettePaths(scenarioKey: string, dir: string = DEFAULT_CASSETTE_DIR): string[] {
  const own = cassettePath(scenarioKey, dir);
  if (scenarioKey !== 'default' || existsSync(own) || !existsSync(dir)) return [own];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => join(dir, f));
}

interface LoadedEntry {
  key: string;
  kind: 'llm' | 'jev';
  /** The graph step that made the call: the node for LLM calls, the tag for Jev calls. */
  group: string;
  /** Position across all files read, in file order. */
  index: number;
  path: string;
  response: unknown;
  used: boolean;
}

/**
 * Reads a scenario's cassette once. An entry is found by its exact content key first. Some prompts
 * are not reproducible: the specialist agents run in parallel, so the "evidence so far" in their
 * prompts depends on which branch finished first, and a fresh database can order it differently
 * from the recording run. When the exact key misses but this run has already matched a recorded
 * call in the same file, the reader falls back to the unused recording for the same step (node or
 * tag) closest to that match. With no earlier match there is nothing to anchor on, so it still
 * misses: a case that was never recorded escalates instead of borrowing another case's answers.
 * Each entry answers one call only.
 */
export class CassetteReader {
  private entries: LoadedEntry[] | null = null;
  private lastHit: LoadedEntry | null = null;

  constructor(private readonly paths: string | string[]) {}

  private async load(): Promise<LoadedEntry[]> {
    if (this.entries) return this.entries;
    const entries: LoadedEntry[] = [];
    for (const path of Array.isArray(this.paths) ? this.paths : [this.paths]) {
      if (!existsSync(path)) continue;
      const text = await readFile(path, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as CassetteEntry;
        const meta = entry.meta as { node?: string; tag?: string };
        entries.push({
          key: entry.key,
          kind: entry.kind,
          group: String(meta.node ?? meta.tag ?? ''),
          index: entries.length,
          path,
          response: entry.response,
          used: false,
        });
      }
    }
    this.entries = entries;
    return entries;
  }

  /** `group` is the graph step making the call (LLM node or Jev tag); it enables the fallback. */
  async read(key: string, kind: 'llm' | 'jev', group?: string): Promise<unknown> {
    const entries = await this.load();
    const exact = entries.find((e) => !e.used && e.key === key);
    if (exact) {
      exact.used = true;
      this.lastHit = exact;
      return exact.response;
    }
    const anchor = this.lastHit;
    if (anchor && group) {
      let best: LoadedEntry | null = null;
      for (const e of entries) {
        if (e.used || e.kind !== kind || e.group !== group || e.path !== anchor.path) continue;
        if (!best || Math.abs(e.index - anchor.index) < Math.abs(best.index - anchor.index)) best = e;
      }
      if (best) {
        best.used = true;
        return best.response;
      }
    }
    throw new ReplayMissError(key, kind);
  }
}

/** Appends one recorded call. Safe to call concurrently: each call is one atomic line append. */
export async function appendCassette(path: string, entry: CassetteEntry): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}
