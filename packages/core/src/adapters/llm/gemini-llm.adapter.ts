/**
 * LIVE adapter: LangChain's Gemini chat model with `.withStructuredOutput`, temperature 0
 * (docs/03-agent-system.md §14). This is the only adapter that makes a network call.
 */
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { z } from 'zod';
import type { LlmCallMeta, LlmMessage, LlmPort, LlmResult } from '../../ports/llm';

interface StructuredRaw {
  usage_metadata?: { input_tokens?: number; output_tokens?: number };
  response_metadata?: { usage?: { input_tokens?: number; output_tokens?: number } };
}

export class GeminiLlmAdapter implements LlmPort {
  private readonly model: ChatGoogleGenerativeAI;

  constructor(opts: { apiKey: string; model: string; temperature?: number }) {
    this.model = new ChatGoogleGenerativeAI({ apiKey: opts.apiKey, model: opts.model, temperature: opts.temperature ?? 0 });
  }

  async invokeStructured<T>(schema: z.ZodType<T>, messages: LlmMessage[], _meta: LlmCallMeta): Promise<LlmResult<T>> {
    const structured = this.model.withStructuredOutput(schema, { includeRaw: true });
    const result = (await structured.invoke(messages.map((m) => ({ role: m.role, content: m.content })))) as {
      raw?: StructuredRaw;
      parsed: T;
    };
    const usage = result.raw?.usage_metadata ?? result.raw?.response_metadata?.usage;
    return {
      data: schema.parse(result.parsed),
      usage: { inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 },
    };
  }
}
