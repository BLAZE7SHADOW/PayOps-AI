import type { Questions, SystemOneResult } from '@typesafe-ai/sdk';
import type { DecisionPort, DecisionRequest } from '../../ports/decision';
import { appendCassette, cassetteKey, cassettePath, stableHash } from '../cassette';

export class RecordingDecisionAdapter implements DecisionPort {
  private callIndex = 0;

  constructor(
    private readonly inner: DecisionPort,
    private readonly scenarioKey: string,
    private readonly dir?: string,
  ) {}

  async ask<Q extends Questions>(req: DecisionRequest<Q>): Promise<SystemOneResult<Q>> {
    const result = await this.inner.ask(req);
    const index = this.callIndex++;
    const key = cassetteKey(req.tag, index, stableHash({ state: req.state, questions: req.questions }));
    await appendCassette(cassettePath(this.scenarioKey, this.dir), {
      key,
      kind: 'jev',
      meta: { tag: req.tag, callIndex: index },
      response: result,
    });
    return result;
  }
}
