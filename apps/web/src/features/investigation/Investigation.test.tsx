/**
 * Phase 4 task 8: the trace's Jev decision rendering (docs/03 §4 J1-J6) and the grounding-aware
 * findings rendering (docs/03 §4a "J4", docs/05 §11) -- both pure-render pieces exported from
 * Investigation.tsx precisely so they're testable without the query hooks the full screen needs
 * (see VerificationTable.test.tsx / DecisionForm.test.tsx for this codebase's usual shape).
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AgentRunItem, AgentStepItem, Finding, GroundingViolation } from '@payops/shared';
import { FindingLine, Trace } from './Investigation';

const baseRun: AgentRunItem = {
  id: 'run_1',
  caseId: 'case_1',
  resolutionId: null,
  status: 'RESOLVED',
  path: 'FULL',
  attempt: 1,
  budget: { llmCalls: 1, jevCalls: 1, toolCalls: 1, tokensIn: 10, tokensOut: 10, costUsd: 0 },
  diagnosis: null,
  proposal: null,
  policy: null,
  approvalId: null,
  executions: [],
  validation: null,
  findings: [],
  evidence: [],
  grounding: null,
  createdAt: '2026-09-28T12:00:00.000Z',
  updatedAt: '2026-09-28T12:00:00.000Z',
  finishedAt: '2026-09-28T12:05:00.000Z',
};

function step(overrides: Partial<AgentStepItem>): AgentStepItem {
  return { id: 'st_1', runId: 'run_1', seq: 1, node: 'plan', kind: 'DECISION_MADE', payload: {}, at: '2026-09-28T12:01:00.000Z', ...overrides };
}

describe('Trace: Jev decisions (docs/03 §4, docs/05 §11)', () => {
  it('shows the Jev tag and formats a Choice answer as "key: label (confidence%)"', () => {
    render(<Trace run={baseRun} steps={[step({
      payload: { tag: 'J2_PLAN', answers: { primary_hypothesis: { type: 'choice', choice: 'WEBHOOK_PROCESSING_FAILURE', confidence: 0.923, probabilities: {} } } },
    })]} />);
    expect(screen.getByText('J2_PLAN')).toBeInTheDocument();
    expect(screen.getByText('primary_hypothesis: WEBHOOK_PROCESSING_FAILURE (92.3%)')).toBeInTheDocument();
  });

  it('formats a Noul answer as a bare percentage (no separate confidence field on Noul)', () => {
    render(<Trace run={baseRun} steps={[step({
      node: 'groundCheck', payload: { tag: 'J4_GROUND', answers: { sufficient: { type: 'noul', noul: 0.87 } } },
    })]} />);
    expect(screen.getByText('sufficient: 87%')).toBeInTheDocument();
  });

  it('formats a Score answer as "key: score (confidence%)"', () => {
    render(<Trace run={baseRun} steps={[step({
      node: 'riskAgent', payload: { tag: 'J3_RISK', answers: { velocity_abuse: { type: 'score', score: 2, confidence: 0.81, legend: {}, probabilities: {} } } },
    })]} />);
    expect(screen.getByText('velocity_abuse: 2 (81%)')).toBeInTheDocument();
  });

  it('renders nothing extra for a step with no DECISION_MADE payload', () => {
    render(<Trace run={baseRun} steps={[step({ kind: 'NODE_STARTED', payload: {} })]} />);
    expect(screen.queryByText(/J2_PLAN|J3_RISK|J4_GROUND|J6_DIAGNOSE/)).not.toBeInTheDocument();
  });
});

describe('Trace: LLM call context size (docs/03 §8, Phase 4 "context sizes per call are visible and within budget")', () => {
  it('shows a within-budget call in the muted color', () => {
    const { container } = render(<Trace run={baseRun} steps={[step({
      node: 'paymentAgent', kind: 'LLM_CALLED', payload: { call: 'findings', contextTokenEstimate: 900 },
    })]} />);
    expect(screen.getByText('findings context: 900 / 1,800 tok budget')).toBeInTheDocument();
    expect(container.querySelector('.text-bad')).not.toBeInTheDocument();
  });

  it('flags an over-budget call in --bad with a note that sections were dropped', () => {
    render(<Trace run={baseRun} steps={[step({
      node: 'paymentAgent', kind: 'LLM_CALLED', payload: { call: 'findings', contextTokenEstimate: 2500 },
    })]} />);
    const line = screen.getByText(/findings context: 2,500/);
    expect(line).toHaveClass('text-bad');
    expect(line).toHaveTextContent('(over budget, sections dropped)');
  });

  it('renders nothing when the payload has no token estimate', () => {
    render(<Trace run={baseRun} steps={[step({ node: 'paymentAgent', kind: 'LLM_CALLED', payload: { call: 'findings' } })]} />);
    expect(screen.queryByText(/context:/)).not.toBeInTheDocument();
  });
});

const ev01Finding: Finding = {
  id: 'fd_01',
  agent: 'payment',
  code: 'WEBHOOK_HTTP_500',
  statement: 'The captured webhook failed with HTTP 500.',
  evidenceIds: ['ev_01'],
  confidence: 0.9,
};

describe('FindingLine: grounding status (docs/03 §4a J4, docs/05 §9)', () => {
  it('renders a surviving finding normally, with a clickable evidence citation', () => {
    render(<FindingLine finding={ev01Finding} violation={null} citation={(id) => <a href={`#${id}`}>[{id}]</a>} />);
    const statement = screen.getByText(/The captured webhook failed/);
    expect(statement).not.toHaveClass('line-through');
    expect(screen.getByRole('link', { name: '[ev_01]' })).toBeInTheDocument();
  });

  it('strikes through a dropped finding, shows its reason, and never colors it --bad', () => {
    const violation: GroundingViolation = { findingId: 'fd_01', reason: 'Jev J4 marked this claim contradicted' };
    const { container } = render(<FindingLine finding={ev01Finding} violation={violation} citation={(id) => <a href={`#${id}`}>[{id}]</a>} />);
    const statement = screen.getByText(/The captured webhook failed/);
    expect(statement).toHaveClass('line-through');
    expect(statement).toHaveClass('text-ink-2'); // muted, not --bad (docs/05 status colors are for live verdicts only)
    expect(container.querySelector('.text-bad')).not.toBeInTheDocument();
    expect(screen.getByText('Dropped: Jev J4 marked this claim contradicted')).toBeInTheDocument();
    // a dropped finding's citation is plain mono text, not a link (nothing to click through to as if live)
    expect(screen.queryByRole('link', { name: '[ev_01]' })).not.toBeInTheDocument();
    expect(within(container).getByText('[ev_01]').tagName).toBe('SPAN');
  });
});
