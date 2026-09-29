import { useState } from 'react';
import { ROOT_CAUSES, type AgentRunItem, type DiagnosisFeedbackBody, type DiagnosisFeedbackItem, type RootCause } from '@payops/shared';
import { statusLabel } from '../../lib/format';
import { can } from '../../lib/permissions';
import { useUser } from '../../lib/session';
import { Button } from '../../ui/Button';
import { ErrorState } from '../../ui/ErrorState';
import { Field } from '../../ui/Field';
import { Segmented } from '../../ui/Segmented';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { Textarea } from '../../ui/Textarea';
import { useRunFeedback, useSubmitFeedback } from './api';

const VERDICT_OPTIONS = [
  { value: 'RIGHT', label: 'Right' },
  { value: 'WRONG', label: 'Wrong' },
] as const;

const CAUSE_OPTIONS = ROOT_CAUSES.filter((c) => c !== 'UNKNOWN').map((c) => ({ value: c, label: statusLabel(c) }));

const MIN_REASON = 3;

interface FormProps {
  diagnosedRootCause: RootCause;
  /** This operator's earlier verdict on the run, if any. */
  previous: DiagnosisFeedbackItem | null;
  pending: boolean;
  error: string | null;
  onSubmit: (body: DiagnosisFeedbackBody) => void;
}

/** Pure form: no queries, so it renders and tests without network hooks. */
export function FeedbackForm({ diagnosedRootCause, previous, pending, error, onSubmit }: FormProps) {
  const [verdict, setVerdict] = useState<'RIGHT' | 'WRONG'>(previous?.verdict ?? 'RIGHT');
  const [reason, setReason] = useState(previous?.reason ?? '');
  const [cause, setCause] = useState<RootCause | undefined>(previous?.correctRootCause ?? undefined);
  const [touched, setTouched] = useState(false);

  const reasonMissing = verdict === 'WRONG' && reason.trim().length < MIN_REASON;
  const submit = () => {
    setTouched(true);
    if (reasonMissing) return;
    onSubmit({ verdict, reason: reason.trim(), ...(verdict === 'WRONG' && cause ? { correctRootCause: cause } : {}) });
  };

  return (
    <form
      className="space-y-4 px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-14 text-ink">
        The agent's diagnosis was <span className="font-mono text-13">{statusLabel(diagnosedRootCause)}</span>. Was that the real cause?
      </p>
      <Segmented label="Was the diagnosis right?" value={verdict} options={VERDICT_OPTIONS} onChange={setVerdict} />
      {verdict === 'WRONG' ? (
        <>
          <Field label="What was the cause?" hint="Optional. Pick the cause you believe it was.">
            {() => <Select label="What was the cause?" allLabel="Not sure" value={cause} options={CAUSE_OPTIONS} onChange={setCause} mono width={320} />}
          </Field>
          <Field
            label="Why is it wrong?"
            hint="One or two plain sentences. This is what improves the checks."
            error={touched && reasonMissing ? 'Say briefly why the diagnosis is wrong.' : null}
            aside={`${reason.length}/500`}
          >
            {(f) => <Textarea {...f} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </>
      ) : null}
      {error ? <p role="alert" className="text-13 text-bad">{error}</p> : null}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving' : previous ? 'Update feedback' : 'Save feedback'}
        </Button>
        {previous ? <span className="text-12 text-ink-2">You answered {previous.verdict === 'RIGHT' ? 'right' : 'wrong'} earlier.</span> : null}
      </div>
    </form>
  );
}

/** Read-only list of what operators said, shown to everyone including viewers. */
export function FeedbackList({ items }: { items: readonly DiagnosisFeedbackItem[] }) {
  if (items.length === 0) return <p className="px-5 py-4 text-14 text-ink-2">No one has judged this diagnosis yet.</p>;
  return (
    <ul className="divide-y divide-rule">
      {items.map((f) => (
        <li key={f.id} className="px-5 py-3 text-14">
          <p>
            <span className="font-medium">{f.givenByName}</span> said <span className="font-medium">{f.verdict === 'RIGHT' ? 'right' : 'wrong'}</span>
            {f.correctRootCause ? <> and named <span className="font-mono text-13">{statusLabel(f.correctRootCause)}</span></> : null}.
          </p>
          {f.reason ? <p className="mt-1 text-ink-2">{f.reason}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/** Feedback panel on the run page. Needs a diagnosis; viewers can read but not submit. */
export function DiagnosisFeedback({ run }: { run: AgentRunItem }) {
  const user = useUser();
  const list = useRunFeedback(run.id);
  const submit = useSubmitFeedback(run.id);
  const diagnosis = run.diagnosis;

  if (!diagnosis) return null;
  const mine = list.data?.items.find((f) => f.givenById === user?.id) ?? null;

  return (
    <section aria-labelledby="feedback-title" className="mt-8 rounded-lg border border-rule bg-surface">
      <header className="border-b border-rule px-5 py-3">
        <h2 id="feedback-title" className="text-16 font-semibold">Your feedback on this diagnosis</h2>
      </header>
      {list.isError ? (
        <ErrorState title="Could not load feedback." error={list.error} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <div className="px-5 py-4" aria-hidden="true"><Skeleton height={44} width="100%" /></div>
      ) : (
        <>
          {can(user?.role, 'judge') ? (
            <FeedbackForm
              key={mine?.updatedAt ?? 'new'}
              diagnosedRootCause={diagnosis.rootCause}
              previous={mine}
              pending={submit.isPending}
              error={submit.isError ? submit.error.message : null}
              onSubmit={(body) => submit.mutate(body)}
            />
          ) : (
            <p className="px-5 py-4 text-14 text-ink-2">You have view access. Feedback needs an Ops or manager account.</p>
          )}
          <div className="border-t border-rule">
            <FeedbackList items={list.data.items} />
          </div>
        </>
      )}
    </section>
  );
}
