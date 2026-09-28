import type { Questions, SystemOneResult } from '@typesafe-ai/sdk';
import type { DecisionPort, DecisionRequest } from '../../ports/decision';
import { CassetteReader, cassetteKey, cassettePath, stableHash } from '../cassette';

export class ReplayDecisionAdapter implements DecisionPort {
  private readonly reader: CassetteReader;
  private callIndex = 0;

  constructor(scenarioKey: string, dir?: string) {
    this.reader = new CassetteReader(cassettePath(scenarioKey, dir));
  }

  async ask<Q extends Questions>(req: DecisionRequest<Q>): Promise<SystemOneResult<Q>> {
    const index = this.callIndex++;
    const key = cassetteKey(req.tag, index, stableHash({ state: req.state, questions: req.questions }));
    return (await this.reader.read(key, 'jev')) as SystemOneResult<Q>;
  }
}
