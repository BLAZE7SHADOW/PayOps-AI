import { useState } from 'react';
import { formatMoney, type CaseDetail } from '@payops/shared';
import { can } from '../../lib/permissions';
import { useSession } from '../../lib/session';
import { Button } from '../../ui/Button';
import { useUndoResolution } from '../resolution/api';
import { undoableResolution } from './undo';

interface ViewProps {
  amountMinor: number;
  pending: boolean;
  error: string | null;
  onUndo: () => void;
}

/** Two steps on purpose: the first click explains what will happen, the second sends it. */
export function UndoResolutionView({ amountMinor, pending, error, onUndo }: ViewProps) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 text-13 text-ink-2">
      {confirming ? (
        <>
          <span>
            This reopens the case and proposes reversing the {formatMoney(amountMinor)} ledger entry. It goes through approval like any other fix.
          </span>
          <Button size="sm" disabled={pending} onClick={onUndo}>
            {pending ? 'Sending' : 'Propose undo'}
          </Button>
          <Button variant="quiet" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button variant="quiet" size="sm" onClick={() => setConfirming(true)}>
          Undo ledger post
        </Button>
      )}
      {error ? <span role="alert" className="text-bad">{error}</span> : null}
    </div>
  );
}

/** Shown under the verdict when the case's last fix posted to the ledger and can be reversed. */
export function UndoResolution({ c }: { c: CaseDetail }) {
  const me = useSession().data;
  const undo = useUndoResolution(c.id);
  const target = undoableResolution(c);
  if (!target || !me || !can(me.role, 'undo')) return null;
  return (
    <UndoResolutionView
      amountMinor={c.amountMinor}
      pending={undo.isPending}
      error={undo.isError ? (undo.error instanceof Error ? undo.error.message : 'Could not undo.') : null}
      onUndo={() => undo.mutate(target.id)}
    />
  );
}
