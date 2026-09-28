/** RECORD adapter: calls through to a real LlmPort, then appends the response to a cassette. */
import type { z } from 'zod';
import type { LlmCallMeta, LlmMessage, LlmPort, LlmResult } from '../../ports/llm';
import { appendCassette, cassetteKey, cassettePath, stableHash } from '../cassette';

export class RecordingLlmAdapter implements LlmPort {
  constructor(
    private readonly inner: LlmPort,
    private readonly scenarioKey: string,
    private readonly dir?: string,
  ) {}

  async invokeStructured<T>(schema: z.ZodType<T>, messages: LlmMessage[], meta: LlmCallMeta): Promise<LlmResult<T>> {
    const result = await this.inner.invokeStructured(schema, messages, meta);
    const key = cassetteKey(meta.node, meta.callIndex, stableHash(messages));
    await appendCassette(cassettePath(this.scenarioKey, this.dir), {
      key,
      kind: 'llm',
      meta: { node: meta.node, callIndex: meta.callIndex },
      response: result,
    });
    return result;
  }
}
