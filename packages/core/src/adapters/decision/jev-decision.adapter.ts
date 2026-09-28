/**
 * LIVE adapter over `@typesafe-ai/sdk` (docs/03-agent-system.md §4 "Jev adapter contract").
 * The env var name (`TYPESAFE_JEV_API_KEY`) differs from the SDK's default (`TYPESAFE_API_KEY`),
 * so the key is always passed explicitly. The model is pinned via `JEV_MODEL`, never `jev-latest`,
 * so recordings stay valid.
 */
import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { Questions, SystemOneResult } from '@typesafe-ai/sdk';
import type { DecisionPort, DecisionRequest } from '../../ports/decision';

export class JevDecisionAdapter implements DecisionPort {
  private readonly client: TypeSafeClient;

  constructor(opts: { apiKey: string; model: string }) {
    this.client = new TypeSafeClient({ apiKey: opts.apiKey, defaultModel: opts.model });
  }

  async ask<Q extends Questions>(req: DecisionRequest<Q>): Promise<SystemOneResult<Q>> {
    return this.client.systemOne({ state: req.state, questions: req.questions });
  }
}
