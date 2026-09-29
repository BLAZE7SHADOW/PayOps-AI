import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CassetteReader, ReplayMissError, replayCassettePaths } from './cassette';

const line = (key: string, response: unknown) => `${JSON.stringify({ key, kind: 'jev', meta: {}, response })}\n`;

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cassettes-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe('replayCassettePaths', () => {
  it('uses the scenario file for a named scenario', () => {
    const dir = dirWith({ 'a.jsonl': '', 'b.jsonl': '' });
    expect(replayCassettePaths('a', dir)).toEqual([join(dir, 'a.jsonl')]);
  });
  it("reads every scenario cassette for 'default' when no default.jsonl exists", () => {
    const dir = dirWith({ 'b.jsonl': '', 'a.jsonl': '', 'README.md': '' });
    expect(replayCassettePaths('default', dir)).toEqual([join(dir, 'a.jsonl'), join(dir, 'b.jsonl')]);
  });
  it("prefers a recorded default.jsonl over merging", () => {
    const dir = dirWith({ 'default.jsonl': '', 'a.jsonl': '' });
    expect(replayCassettePaths('default', dir)).toEqual([join(dir, 'default.jsonl')]);
  });
});

describe('CassetteReader over several files', () => {
  it('answers each key from whichever file recorded it, and still misses unknown keys', async () => {
    const dir = dirWith({ 'a.jsonl': line('k1', 'from-a'), 'b.jsonl': line('k2', 'from-b') });
    const reader = new CassetteReader(replayCassettePaths('default', dir));
    expect(await reader.read('k2', 'jev')).toBe('from-b');
    expect(await reader.read('k1', 'jev')).toBe('from-a');
    await expect(reader.read('k3', 'jev')).rejects.toBeInstanceOf(ReplayMissError);
  });
});

describe('CassetteReader fallback for unreproducible prompts', () => {
  const entry = (key: string, tag: string, response: string) =>
    `${JSON.stringify({ key, kind: 'jev', meta: { tag, callIndex: 0 }, response })}\n`;

  it('answers a missed call from the same step once the run has matched something in that file', async () => {
    const dir = dirWith({ 'a.jsonl': entry('k1', 'ANCHOR', 'anchor') + entry('k2', 'STEP', 'one') + entry('k3', 'STEP', 'two') });
    const reader = new CassetteReader(replayCassettePaths('a', dir));
    expect(await reader.read('k1', 'jev', 'ANCHOR')).toBe('anchor');
    expect(await reader.read('changed', 'jev', 'STEP')).toBe('one');
    expect(await reader.read('changed-again', 'jev', 'STEP')).toBe('two');
    await expect(reader.read('third', 'jev', 'STEP')).rejects.toBeInstanceOf(ReplayMissError);
  });

  it('still misses when nothing in the run matched, so unrecorded cases escalate', async () => {
    const dir = dirWith({ 'a.jsonl': entry('k1', 'STEP', 'one') });
    const reader = new CassetteReader(replayCassettePaths('a', dir));
    await expect(reader.read('changed', 'jev', 'STEP')).rejects.toBeInstanceOf(ReplayMissError);
  });

  it('never borrows from a different file than the one it matched', async () => {
    const dir = dirWith({ 'a.jsonl': entry('k1', 'ANCHOR', 'a'), 'b.jsonl': entry('k2', 'STEP', 'from-b') });
    const reader = new CassetteReader(replayCassettePaths('default', dir));
    expect(await reader.read('k1', 'jev', 'ANCHOR')).toBe('a');
    await expect(reader.read('changed', 'jev', 'STEP')).rejects.toBeInstanceOf(ReplayMissError);
  });
});
