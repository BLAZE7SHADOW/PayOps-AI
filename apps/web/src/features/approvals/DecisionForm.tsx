import { useRef, useState } from 'react';
import type { ApprovalDecisionType, ApprovalItem, Role } from '@payops/shared';
import { VIEW_ONLY_NOTE, can } from '../../lib/permissions';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { Textarea } from '../../ui/Textarea';

export const COMMENT_MIN = 5;
const COMMENT_MAX = 1000;

const VERB: Record<ApprovalDecisionType, { idle: string; pending: string; need: string }> = {
  APPROVE: { idle: 'Approve', pending: 'Approving…', need: 'approve' },
  REJECT: { idle: 'Reject', pending: 'Rejecting…', need: 'reject' },
  ESCALATE: { idle: 'Escalate', pending: 'Escalating…', need: 'escalate' },
};

interface DecisionFormProps {
  approval: Pick<ApprovalItem, 'canDecide' | 'cannotDecideReason' | 'tier'>;
  role: Role | undefined;
  pending: ApprovalDecisionType | null;
  onDecide: (decision: ApprovalDecisionType, comment: string) => void;
}

/**
 * Approve / Reject / Escalate with a comment. Reject and Escalate need a comment of at least five
 * characters (same rule as ApprovalDecisionBody on the server). When the viewer may not decide,
 * the reason from the server is shown and every control is disabled.
 */
export function DecisionForm({ approval, role, pending, onDecide }: DecisionFormProps) {
  const [comment, setComment] = useState('');
  const [choice, setChoice] = useState<ApprovalDecisionType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  if (!can(role, 'decide')) return <p className="text-13 text-ink-2">{VIEW_ONLY_NOTE}</p>;

  const disabled = !approval.canDecide || pending !== null;

  const decide = () => {
    if (!choice) return;
    const text = comment.trim();
    if (choice !== 'APPROVE' && text.length < COMMENT_MIN) {
      setError(`Add a comment of at least ${COMMENT_MIN} characters to ${VERB[choice].need}.`);
      ref.current?.focus();
      return;
    }
    setError(null);
    onDecide(choice, text);
  };

  return (
    <div className="flex flex-col gap-2">
      {!approval.canDecide ? (
        <p role="note" className="border border-rule bg-surface-sunk px-3 py-2 text-13 text-ink">
          {approval.cannotDecideReason ?? 'You cannot decide this approval.'}
        </p>
      ) : null}
      <Field
        label="Comment"
        aside={
          <span className="tabular font-mono">
            {comment.trim().length} / {COMMENT_MAX}
          </span>
        }
        hint={`Optional to approve. Required to reject or escalate, at least ${COMMENT_MIN} characters.`}
        error={error}
      >
        {(a) => (
          <Textarea
            {...a}
            ref={ref}
            rows={2}
            maxLength={COMMENT_MAX}
            disabled={disabled}
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
              if (error && e.target.value.trim().length >= COMMENT_MIN) setError(null);
            }}
            className="disabled:cursor-not-allowed disabled:opacity-55"
          />
        )}
      </Field>
      <fieldset disabled={disabled} className="space-y-3">
        <legend className="mb-2 text-14 font-medium">Decision <span className="font-mono text-12 font-normal text-ink-2">· {approval.tier} tier</span></legend>
        <div className="flex flex-wrap gap-2">
          {(['APPROVE', 'REJECT', 'ESCALATE'] as const).map((option) => (
            <label key={option} className={`inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-4 text-14 ${choice === option ? 'border-accent bg-accent-weak text-ink' : 'border-control bg-surface text-ink'} has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent`}>
              <input type="radio" name="approval-decision" value={option} checked={choice === option} onChange={() => { setChoice(option); setError(null); }} className="accent-accent" />
              {VERB[option].idle}
            </label>
          ))}
        </div>
        <Button variant={choice === 'REJECT' ? 'danger-solid' : 'primary'} disabled={disabled || !choice} onClick={decide}>
          {pending ? VERB[pending].pending : choice ? `${VERB[choice].idle} decision` : 'Choose a decision'}
        </Button>
      </fieldset>
    </div>
  );
}
