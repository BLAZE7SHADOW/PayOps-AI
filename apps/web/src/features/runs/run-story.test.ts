import type { AgentRunItem, AgentStepItem } from '@payops/shared';
import { describe, expect, it } from 'vitest';
import { nodeStory } from './run-story';
import type { NodeVisit } from './run-flow';

const at = '2026-09-29T10:00:00Z';
function visit(node: string, steps: Array<[AgentStepItem['kind'], Record<string, unknown>]>): NodeVisit {
  return { node, startedAt: at, state: 'COMPLETED', steps: steps.map(([kind, payload], i) => ({ id: String(i), runId: 'run_1', seq: i + 1, node, kind, payload, at })) };
}

describe('nodeStory', () => {
  it('explains the risk result and its recorded signals without exposing the J3 code', () => {
    const v = visit('riskAgent', [
      ['DECISION_MADE', { tag: 'J3_RISK', tier: 'HIGH', answers: { velocity_abuse: { score: 2.4 }, identity_mismatch: { score: 2.1 } } }],
      ['NODE_COMPLETED', { tier: 'HIGH' }],
    ]);
    const run = { evidence: [{ source: 'getFailedAttempts', facts: { failed24h: 8 } }, { source: 'getDeviceSignals', facts: { cardCountriesDistinct: 3 } }] } as unknown as Partial<AgentRunItem>;
    const story = nodeStory(v, run);
    expect(story.summary).toContain('high risk');
    expect(story.details.join(' ')).toContain('8 failed payment attempts');
    expect(story.details.join(' ')).toContain('Cards from 3 countries');
    expect(story.details.join(' ')).toContain('does not authorize');
    expect(JSON.stringify(story)).not.toContain('J3_RISK');
  });

  it('names the specialists selected by the recorded plan', () => {
    const story = nodeStory(visit('plan', [['NODE_COMPLETED', { specialists: ['payment', 'risk'], primaryHypothesis: 'fraud_or_abuse', routedBy: 'JEV' }]]));
    expect(story.summary).toContain('payment records, risk signals');
    expect(story.details).toContain('Initial possibility: suspicious payment activity.');
  });

  it('shows only extra records actually requested and checked by a specialist', () => {
    const v = visit('paymentAgent', [
      ['LLM_CALLED', { call: 'followUps', followUps: [{ tool: 'getOrderTimeline', reason: 'See when the order changed state.' }, { tool: 'getPaymentAttempts', reason: 'Check recent retries.' }] }],
      ['TOOL_COMPLETED', { tools: ['getOrderTimeline'], evidenceIds: ['ev_4'] }],
      ['FINDING_CREATED', { findingIds: ['fd_1'] }],
    ]);
    const run = { findings: [{ id: 'fd_1', agent: 'payment', statement: 'The order remained failed.', evidenceIds: ['ev_4'] }] } as unknown as Partial<AgentRunItem>;
    const story = nodeStory(v, run);
    expect(story.details[0]).toBe('Requested order history: See when the order changed state.');
    expect(story.details.join(' ')).not.toContain('recent payment attempts');
  });

  it('does not attach the final diagnosis or proposal to an earlier visit', () => {
    const story = nodeStory(visit('resolve', [['NODE_STARTED', {}]]));
    expect(story.summary).toContain('no proposal was recorded');
  });

  it('uses each visit’s recorded outcome when a run changes course', () => {
    const finalRun = { path: 'FULL', grounding: { violations: [] } } as unknown as Partial<AgentRunItem>;
    expect(nodeStory(visit('diagnose', [['NODE_COMPLETED', { path: 'FAST' }]]), finalRun).summary).toContain('Matched a known issue pattern');
    expect(nodeStory(visit('groundCheck', [['NODE_COMPLETED', { violations: [{ findingId: 'fd_1' }] }]]), finalRun).details).toContain('1 finding(s) failed the evidence check.');
  });
});
