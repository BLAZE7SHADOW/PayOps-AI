/** REPLAY adapter: no network. Looks the response up by cassette key; throws ReplayMissError on a miss. */
import type { z } from 'zod';
import type { LlmCallMeta, LlmMessage, LlmPort, LlmResult } from '../../ports/llm';
import { CassetteReader, cassetteKey, replayCassettePaths, stableHash } from '../cassette';

export class ReplayLlmAdapter implements LlmPort {
  private readonly reader: CassetteReader;

  constructor(scenarioKey: string, dir?: string) {
    this.reader = new CassetteReader(replayCassettePaths(scenarioKey, dir));
  }

  async invokeStructured<T>(schema: z.ZodType<T>, messages: LlmMessage[], meta: LlmCallMeta): Promise<LlmResult<T>> {
    const key = cassetteKey(meta.node, meta.callIndex, stableHash(messages));
    const result = (await this.reader.read(key, 'llm', meta.node)) as LlmResult<T>;
    return { ...result, data: schema.parse(result.data) };
  }
}
