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
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  if (!can(role, 'decide')) return <p className="text-13 text-ink-2">{VIEW_ONLY_NOTE}</p>;

  const disabled = !approval.canDecide || pending !== null;

  const decide = (d: ApprovalDecisionType) => {
    const text = comment.trim();
    if (d !== 'APPROVE' && text.length < COMMENT_MIN) {
      setError(`Add a comment of at least ${COMMENT_MIN} characters to ${VERB[d].need}.`);
      ref.current?.focus();
      return;
    }
    setError(null);
    onDecide(d, text);
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
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={disabled} onClick={() => decide('APPROVE')}>
          {pending === 'APPROVE' ? VERB.APPROVE.pending : VERB.APPROVE.idle}
        </Button>
        <Button variant="danger" disabled={disabled} onClick={() => decide('REJECT')}>
          {pending === 'REJECT' ? VERB.REJECT.pending : VERB.REJECT.idle}
        </Button>
        <Button variant="secondary" disabled={disabled} onClick={() => decide('ESCALATE')}>
          {pending === 'ESCALATE' ? VERB.ESCALATE.pending : VERB.ESCALATE.idle}
        </Button>
        <span className="ml-auto font-mono text-12 text-ink-2">{approval.tier} tier</span>
      </div>
    </div>
  );
}
