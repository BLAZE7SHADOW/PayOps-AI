import { useState } from 'react';
import { Link } from 'react-router';
import type { AgentControlBody, AgentControlItem, AgentControlMode } from '@payops/shared';
import { formatDateTime } from '../../lib/format';
import { can } from '../../lib/permissions';
import { useUser } from '../../lib/session';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { Segmented } from '../../ui/Segmented';
import { Textarea } from '../../ui/Textarea';
import { useAgentControl, useSetAgentControl } from './api';

export const MODE_LABEL: Record<AgentControlMode, string> = { NORMAL: 'Normal', PROPOSE_ONLY: 'Propose only', PAUSED: 'Paused' };

const MODE_OPTIONS = (['NORMAL', 'PROPOSE_ONLY', 'PAUSED'] as const).map((value) => ({ value, label: MODE_LABEL[value] }));

const MODE_EXPLAINED: Record<AgentControlMode, string> = {
  NORMAL: 'The agent investigates and proposes. Policy decides which fixes run without approval.',
  PROPOSE_ONLY: 'The agent investigates and proposes, but a person approves every fix. Nothing runs on its own.',
  PAUSED: 'No new investigations start. A fix from a run already in progress waits for a person. People can still resolve cases by hand.',
};

/** One sentence for the banner and the case page; null while the agent is running normally. */
export function limitSentence(c: AgentControlItem): string | null {
  if (c.mode === 'NORMAL') return null;
  const why = c.reason ? `: ${c.reason}` : '.';
  return c.mode === 'PAUSED' ? `The agent is paused${why}` : `The agent is set to propose only${why}`;
}

/** Shown at the top of every page while the agent is limited. Pure, so it tests without hooks. */
export function AgentControlNotice({ control }: { control: AgentControlItem }) {
  const sentence = limitSentence(control);
  if (!sentence) return null;
  return (
    <div role="status" className="mb-4 rounded-lg border border-warn bg-warn-weak px-4 py-3 text-14">
      <p>
        {sentence}{' '}
        <span className="text-ink-2">
          {control.mode === 'PAUSED' ? 'New investigations are off.' : 'Every agent fix needs approval.'}
          {control.changedByName && control.changedAt ? ` Set by ${control.changedByName}, ${formatDateTime(control.changedAt)}.` : ''}
        </span>{' '}
        <Link to="/policy" className="link">Agent controls</Link>
      </p>
    </div>
  );
}

export function AgentControlBanner() {
  const q = useAgentControl();
  return q.data ? <AgentControlNotice control={q.data} /> : null;
}

interface FormProps {
  current: AgentControlItem;
  pending: boolean;
  error: string | null;
  onSubmit: (body: AgentControlBody) => void;
}

/** Pure form for the switch. Only managers see it enabled. */
export function AgentControlForm({ current, pending, error, onSubmit }: FormProps) {
  const [mode, setMode] = useState<AgentControlMode>(current.mode);
  const [reason, setReason] = useState(current.reason);
  const [touched, setTouched] = useState(false);
  const needsReason = mode !== 'NORMAL';
  const reasonMissing = needsReason && reason.trim().length < 3;
  const unchanged = mode === current.mode && reason.trim() === current.reason;

  return (
    <form
      className="space-y-4 px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!reasonMissing) onSubmit({ mode, reason: needsReason ? reason.trim() : '' });
      }}
    >
      <Segmented label="Agent mode" value={mode} options={MODE_OPTIONS} onChange={setMode} />
      <p className="max-w-[64ch] text-14 text-ink-2">{MODE_EXPLAINED[mode]}</p>
      {needsReason ? (
        <Field
          label="Why?"
          hint="Shown to everyone in the banner."
          error={touched && reasonMissing ? 'Say briefly why the agent is being limited.' : null}
          aside={`${reason.length}/300`}
        >
          {(f) => <Textarea {...f} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      ) : null}
      {error ? <p role="alert" className="text-13 text-bad">{error}</p> : null}
      <Button type="submit" variant="primary" disabled={pending || unchanged}>
        {pending ? 'Saving' : 'Save mode'}
      </Button>
    </form>
  );
}

/** Policy page section: managers change the switch, everyone else reads it. */
export function AgentControlPanel() {
  const user = useUser();
  const q = useAgentControl();
  const set = useSetAgentControl();
  const control = q.data;
  return (
    <section aria-labelledby="agent-control-title" className="mt-8 rounded-lg border border-rule bg-surface">
      <header className="border-b border-rule px-5 py-3">
        <h2 id="agent-control-title" className="text-16 font-semibold">Agent controls</h2>
      </header>
      {!control ? (
        <p className="px-5 py-4 text-14 text-ink-2">{q.isError ? 'Could not load the agent mode.' : 'Loading the agent mode.'}</p>
      ) : can(user?.role, 'control') ? (
        <AgentControlForm
          key={`${control.mode}|${control.changedAt}`}
          current={control}
          pending={set.isPending}
          error={set.isError ? set.error.message : null}
          onSubmit={(body) => set.mutate(body)}
        />
      ) : (
        <div className="space-y-2 px-5 py-4 text-14">
          <p>Mode: <span className="font-medium">{MODE_LABEL[control.mode]}</span></p>
          <p className="text-ink-2">{MODE_EXPLAINED[control.mode]}</p>
          <p className="text-ink-2">Changing the mode needs a manager account.</p>
        </div>
      )}
    </section>
  );
}
