import { useMemo } from 'react';
import type { AgentRunItem, AgentStepItem } from '@payops/shared';
import { formatDateTime, formatTime, statusLabel } from '../../lib/format';
import { Tag } from '../../ui/Tag';
import type { Tone } from '../../lib/status';
import { formatDuration } from './run-metrics';
import { buildRunDetail, type CallDetail, type RunStepDetail } from './run-detail';

const ACTOR_TITLE = {
  PERSON: 'A person decided this', JEV: 'Jev, a typed decision service, decided this',
  GEMINI: 'Gemini, a language model, wrote this', CODE: 'Fixed code produced this, no model involved',
} as const;

const STATE_TAG: Partial<Record<RunStepDetail['state'], { tone: Tone; label: string }>> = {
  WAITING: { tone: 'warn', label: 'Waiting' }, RUNNING: { tone: 'accent', label: 'Running' },
  FAILED: { tone: 'bad', label: 'Failed' }, STOPPED: { tone: 'neutral', label: 'Stopped' },
};

const CALL_TAG: Record<CallDetail['kind'], string> = { tools: 'CODE', model: 'GEMINI', jev: 'JEV' };

export const evidenceAnchorId = (id: string) => `run-ev-${id}`;

/**
 * Step by step account of one run: what each step does, whether it is fixed or chosen for this
 * case, what it called, what it found, why it decided that, and what comes next.
 */
export function RunSteps({ run, steps }: { run: AgentRunItem; steps: AgentStepItem[] }) {
  const detail = useMemo(() => buildRunDetail(run, steps), [run, steps]);
  if (!detail.steps.length) return <p className="rounded-lg border border-rule bg-surface px-5 py-4 text-14 text-ink-2">No run events recorded yet.</p>;

  return (
    <div className="space-y-4">
      <section aria-label="How this run was routed" className="rounded-lg border border-rule bg-surface px-5 py-4">
        <h3 className="text-15 font-semibold">How this run was routed</h3>
        <ul className="mt-2 space-y-1 text-14">{detail.overview.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
        <p className="mt-3 border-t border-rule pt-3 text-13 text-ink-2">
          The order of steps is fixed and bounded, so the agent cannot wander or call tools outside a fixed list. What changes from case to case is what happens inside that order:
          whether the fast path is taken, which specialists run, which extra records they ask for, whether an extra evidence round is needed, which policy tier applies, and how the run recovers if verification fails.
          Each step below is labelled <Tag>Fixed step</Tag> or <Tag tone="accent">Chosen for this case</Tag>.
        </p>
      </section>

      <ol className="space-y-4">{detail.steps.map((s) => <StepCard key={s.key} step={s} />)}</ol>

      <EvidenceTable run={run} />
    </div>
  );
}

function ActorTags({ step }: { step: RunStepDetail }) {
  return <>{step.actors.map((a) => <Tag key={a} title={ACTOR_TITLE[a]}>{a === 'JEV' && step.jev.length ? `Jev · ${step.jev.join(', ')}` : a}</Tag>)}</>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-1 border-t border-rule py-3 sm:grid-cols-[150px_minmax(0,1fr)]">
      <dt className="text-13 font-medium text-ink-2">{label}</dt>
      <dd className="min-w-0 text-14">{children}</dd>
    </div>
  );
}

function StepCard({ step }: { step: RunStepDetail }) {
  const state = STATE_TAG[step.state];
  return (
    <li className="rounded-lg border border-rule bg-surface px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-13 text-ink-2">{String(step.number).padStart(2, '0')}</span>
        <h3 className="text-16 font-semibold">{step.title}</h3>
        <ActorTags step={step} />
        <Tag tone={step.mode === 'DYNAMIC' ? 'accent' : 'neutral'}>{step.mode === 'DYNAMIC' ? 'Chosen for this case' : 'Fixed step'}</Tag>
        {state ? <Tag tone={state.tone}>{state.label}</Tag> : null}
        <span className="ml-auto flex items-center gap-3 font-mono text-12 text-ink-2">
          {step.durationMs !== null ? <span title="Time from the first to the last event of this step">{formatDuration(step.durationMs)}</span> : null}
          <time dateTime={step.at}>{formatDateTime(step.at)}</time>
        </span>
      </div>
      <p className="mt-1 text-13 text-ink-2">{step.modeNote}</p>

      <dl className="mt-3">
        <Row label="What it does">{step.purpose}</Row>

        {step.calls.length ? (
          <Row label="What it called">
            <ul className="space-y-2">
              {step.calls.map((c, i) => (
                <li key={i}>
                  <span className="mr-2 inline-block align-middle"><Tag>{CALL_TAG[c.kind]}</Tag></span>
                  <span className="font-medium">{c.title}</span>
                  {c.lines.length ? <ul className="mt-1 space-y-0.5 pl-1 font-mono text-12 text-ink-2">{c.lines.map((l, j) => <li key={j}>{l}</li>)}</ul> : null}
                </li>
              ))}
            </ul>
          </Row>
        ) : null}

        <Row label="What it found">
          <ul className="space-y-1">{step.found.map((f, i) => <li key={i}>{f}</li>)}</ul>
          {step.facts.length ? (
            <div className="mt-2">
              <p className="flex items-center gap-2 text-12 font-medium text-ink-2"><Tag tone="ok">Confirmed by data</Tag> Records read</p>
              <ul className="mt-1 divide-y divide-rule border border-rule">
                {step.facts.map((f) => (
                  <li key={f.evidenceId} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2 text-13">
                    <a className="link font-mono text-12" href={`#${evidenceAnchorId(f.evidenceId)}`}>[{f.evidenceId}]</a>
                    <span className="font-medium">{f.label}</span>
                    <span className="min-w-0 font-mono text-12 text-ink-2">{f.summary}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {step.findings.length ? (
            <div className="mt-2 space-y-2">
              {step.findings.map((f) => (
                <div key={f.id} className="border border-rule bg-paper p-3">
                  <p>{f.statement}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-12">
                    <Tag tone="warn">Agent finding</Tag>
                    <Tag tone={f.grounding === 'SUPPORTED' ? 'ok' : f.grounding === 'UNSUPPORTED' ? 'bad' : 'neutral'}>
                      {f.grounding === 'SUPPORTED' ? 'Evidence check passed' : f.grounding === 'UNSUPPORTED' ? 'Not supported by its evidence' : 'Evidence not checked'}
                    </Tag>
                    <span className="text-ink-2">Relies on</span>
                    {f.evidenceIds.map((id) => <a key={id} className="link font-mono" href={`#${evidenceAnchorId(id)}`}>[{id}]</a>)}
                    <span className="font-mono text-ink-2">{f.id} · confidence {Math.round(f.confidence * 100)}%</span>
                  </div>
                  {f.reason ? <p className="mt-1 text-12 text-bad">{f.reason}</p> : null}
                </div>
              ))}
            </div>
          ) : null}
        </Row>

        {step.why.length ? <Row label="Why it decided this"><ul className="space-y-1">{step.why.map((w, i) => <li key={i}>{w}</li>)}</ul></Row> : null}
        {step.retries.length ? <Row label="Retries"><span className="text-warn">{step.retries.join(' ')}</span></Row> : null}
        {step.next ? <Row label="What happens next">{step.next}</Row> : null}
      </dl>

      <details className="mt-1 border-t border-rule pt-2">
        <summary className="cursor-pointer text-13 text-accent">Technical events ({step.events.length})</summary>
        <ol className="mt-2">
          {step.events.map((e) => (
            <li key={e.seq} className="border-b border-rule py-2 text-13 last:border-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span>{statusLabel(e.kind)}</span>
                <time dateTime={e.at} className="tabular font-mono text-12 text-ink-2">{formatTime(e.at)}</time>
              </div>
              {Object.keys(e.payload).length ? <pre className="mt-1 max-h-56 overflow-auto bg-surface-sunk p-2 font-mono text-11 leading-4 break-words whitespace-pre-wrap">{JSON.stringify(e.payload, null, 2)}</pre> : null}
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

function EvidenceTable({ run }: { run: AgentRunItem }) {
  if (!run.evidence.length) return null;
  return (
    <section aria-labelledby="run-evidence-title" className="rounded-lg border border-rule bg-surface">
      <header className="border-b border-rule px-5 py-3">
        <h3 id="run-evidence-title" className="text-15 font-semibold">Evidence collected in this run</h3>
        <p className="mt-1 text-13 text-ink-2">The records behind every claim above. These values were captured by code, not written by a model.</p>
      </header>
      <ol>
        {run.evidence.map((item) => (
          <li key={item.id} id={evidenceAnchorId(item.id)} tabIndex={-1} className="scroll-m-4 border-b border-rule px-5 py-3 text-13 last:border-0 target:bg-accent-weak">
            <div className="flex flex-wrap items-center gap-2"><span className="font-mono font-medium">{item.id}</span><Tag>{item.system}</Tag><span className="font-mono text-12 break-all text-ink-2">{item.source} · {item.entityRef}</span></div>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-12">
              {Object.entries(item.facts).map(([k, v]) => <div key={k} className="contents"><dt className="text-ink-2">{k}</dt><dd className="font-mono break-all">{String(v)}</dd></div>)}
            </dl>
          </li>
        ))}
      </ol>
    </section>
  );
}
