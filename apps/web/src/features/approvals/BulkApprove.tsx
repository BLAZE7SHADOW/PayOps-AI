import { useState } from 'react';
import { BULK_APPROVE_MAX_MINOR, formatMoney, type ApprovalItem, type BulkApprovalResult } from '@payops/shared';
import { Button } from '../../ui/Button';
import { Money } from '../../ui/Money';
import { CaseLink } from '../exceptions/case-cells';

export interface BulkApproveProps {
  /** Approvals already filtered with `bulkEligible`. */
  items: readonly ApprovalItem[];
  pending: boolean;
  error: string | null;
  result: BulkApprovalResult | null;
  onApprove: (ids: string[]) => void;
}

/** Low-risk approvals a person can clear in one step. Each one still runs through the executor and validator. */
export function BulkApprove({ items, pending, error, result, onApprove }: BulkApproveProps) {
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const chosen = items.filter((a) => !unchecked.has(a.id));
  const toggle = (id: string) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (items.length === 0 && !result) return null;
  return (
    <section aria-labelledby="bulk-approve-title" className="mb-4 border border-rule bg-surface">
      <div className="border-b border-rule px-4 py-3">
        <h2 id="bulk-approve-title" className="text-14 font-medium">
          Low-risk approvals
        </h2>
        <p className="text-13 text-ink-2">
          OPS tier, low risk, money moving up to {formatMoney(BULK_APPROVE_MAX_MINOR)}. Approving runs each fix and checks it, one by one.
        </p>
      </div>
      {items.length > 0 ? (
        <ul>
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-3 border-b border-rule px-4 py-2 text-13 last:border-b-0">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                aria-label={`Include ${a.case.displayId}`}
                checked={!unchecked.has(a.id)}
                onChange={() => toggle(a.id)}
              />
              <CaseLink item={a.case} />
              <span className="min-w-0 flex-1 truncate" title={a.actionsSummary}>
                {a.actionsSummary}
              </span>
              {a.moneyMovingMinor ? <Money minor={a.moneyMovingMinor} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        {items.length > 0 ? (
          <Button variant="primary" disabled={pending || chosen.length === 0} onClick={() => onApprove(chosen.map((a) => a.id))}>
            {pending ? 'Approving' : `Approve ${chosen.length} selected`}
          </Button>
        ) : null}
        {error ? (
          <p role="alert" className="text-13 text-bad">
            {error}
          </p>
        ) : null}
        {result ? (
          <p role="status" className="text-13 text-ink-2">
            {result.approved} approved, {result.skipped} skipped, {result.failed} failed.
            {result.items
              .filter((i) => i.outcome !== 'APPROVED')
              .map((i) => ` ${i.displayId ?? i.approvalId}: ${i.message}`)
              .join('')}
          </p>
        ) : null}
      </div>
    </section>
  );
}
