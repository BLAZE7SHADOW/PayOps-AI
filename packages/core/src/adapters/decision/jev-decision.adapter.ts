/**
 * LIVE adapter over `@typesafe-ai/sdk` (docs/03-agent-system.md §4 "Jev adapter contract").
 * The env var name (`TYPESAFE_JEV_API_KEY`) differs from the SDK's default (`TYPESAFE_API_KEY`),
 * so the key is always passed explicitly. The model is pinned via `JEV_MODEL`, never `jev-latest`,
 * so recordings stay valid.
 */
import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { Questions, SystemOneResult } from '@typesafe-ai/sdk';
import type { DecisionPort, DecisionRequest } from '../../ports/decision';
import { withProviderRetry, type ProviderRetrySink } from '../provider-retry';

export class JevDecisionAdapter implements DecisionPort {
  private readonly client: TypeSafeClient;

  constructor(opts: { apiKey: string; model: string; onRetry?: ProviderRetrySink }) {
    // The SDK retries by default. Disable that hidden layer so each attempt is bounded and audited here.
    this.client = new TypeSafeClient({ apiKey: opts.apiKey, defaultModel: opts.model, retry: { maxRetries: 0 } });
    this.onRetry = opts.onRetry;
  }

  private readonly onRetry?: ProviderRetrySink;

  async ask<Q extends Questions>(req: DecisionRequest<Q>): Promise<SystemOneResult<Q>> {
    return withProviderRetry('Jev', () => this.client.systemOne({ state: req.state, questions: req.questions }),
      this.onRetry && ((notice) => this.onRetry?.({ ...notice, step: req.tag })));
  }
}
