import { useMemo, useState } from 'react';
import {
  ACTION_META,
  CASE_TYPE_LABEL,
  formatMoney,
  type ActionOption,
  type CaseDetail,
  type PolicyPreview,
  type PreconditionFailure,
} from '@payops/shared';
import { ApiError } from '../../lib/api';
import { useRealtimeStore } from '../../lib/realtime-store';
import { resolutionTone, submitLabel } from '../../lib/resolution';
import { Button } from '../../ui/Button';
import { Drawer } from '../../ui/Drawer';
import { Field } from '../../ui/Field';
import { Input } from '../../ui/Input';
import { Money } from '../../ui/Money';
import { MonoIds } from '../../ui/MonoIds';
import { Skeleton } from '../../ui/Skeleton';
import { Tag } from '../../ui/Tag';
import { Textarea } from '../../ui/Textarea';
import { cx } from '../../ui/cx';
import { usePolicyPreview, usePropose } from './api';
import { PolicyReasons } from './parts';
import {
  RATIONALE_MAX,
  RATIONALE_MIN,
  buildActions,
  initialDrafts,
  rationaleError,
  validateDraft,
  type Draft,
} from './resolve-form';

interface ResolveDrawerProps {
  c: CaseDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "Resolve manually": the closed action catalog as a form, with a live policy preview. */
export function ResolveDrawer({ c, open, onOpenChange }: ResolveDrawerProps) {
  // The form lives inside the drawer content, which unmounts on close, so every open starts fresh.
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={`Resolve ${c.displayId} manually`} width={760}>
      {open ? <ResolveForm c={c} onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} /> : null}
    </Drawer>
  );
}

export function ResolveForm({ c, onDone, onCancel }: { c: CaseDetail; onDone: () => void; onCancel: () => void }) {
  const options = c.resolutionView.actionOptions;
  const [drafts, setDrafts] = useState<Draft[]>(() => initialDrafts(options));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [rationale, setRationale] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const actions = useMemo(() => buildActions(options, drafts), [options, drafts]);
  const preview = usePolicyPreview(c.id, actions);
  const propose = usePropose(c.id);
  const pushNotice = useRealtimeStore((s) => s.pushNotice);

  const selectedCount = drafts.filter((d, i) => d.checked && options[i]?.available).length;
  const rationaleErr = rationaleError(rationale);
  const tier = preview.settled ? preview.preview?.decision.tier : undefined;
  const blocked = tier === 'BLOCKED';
  const formValid = actions !== null && rationaleErr === null;
  const canSubmit = formValid && preview.settled && !blocked && !propose.isPending;

  const label =
    selectedCount === 0 ? 'Select an action' : actions === null ? 'Fix the highlighted fields' : submitLabel(tier, propose.isPending);

  const update = (i: number, patch: Partial<Draft>) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const touch = (key: string) => setTouched((t) => ({ ...t, [key]: true }));
  const shown = (key: string, err: string | null | undefined) => ((touched[key] || submitted) && err) || null;

  const submit = () => {
    setSubmitted(true);
    if (!actions || rationaleErr || !canSubmit) return;
    // mutateAsync (not mutate + onSuccess): the result must be handled even if this form unmounts
    // while the server executes and verifies the fix.
    propose
      .mutateAsync({ actions, rationale: rationale.trim() })
      .then(
        (r) => {
          const text =
            r.status === 'AWAITING_APPROVAL'
              ? `Requested ${r.policy.tier === 'MANAGER' ? 'manager' : 'OPS'} approval for`
              : r.status === 'BLOCKED'
                ? 'Blocked by policy:'
                : 'Executing the fix for';
          pushNotice({ kind: 'local', text, caseId: c.id, displayId: c.displayId, subject: `case:${c.id}` });
          onDone();
        },
        () => undefined, // error state is rendered from propose.error
      );
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex min-h-full flex-col"
    >
      {/* Sticky so the close button always sits on the header, never on scrolled content. */}
      <header className="sticky top-0 z-[5] border-b border-rule bg-surface px-5 pt-4 pb-4">
        <p className="text-12 text-ink-2">Resolve manually</p>
        <h2 className="mt-0.5 flex flex-wrap items-baseline gap-x-2 pr-10 text-16">
          <span className="tabular font-mono font-semibold">{c.displayId}</span>
          <span className="text-ink-3" aria-hidden="true">·</span>
          <span>{CASE_TYPE_LABEL[c.type]}</span>
          <span className="text-ink-3" aria-hidden="true">·</span>
          <Money minor={c.amountMinor} className="font-medium" />
        </h2>
        <p className="mt-1 max-w-[72ch] text-13 text-ink-2">
          Pick actions from the catalog. Policy code decides whether they run now or need approval; the validator re-reads every system afterwards.
        </p>
      </header>

      <fieldset aria-labelledby="actions-title" className="px-5 pt-4">
        <div className="flex items-baseline justify-between pb-2">
          <h3 id="actions-title" className="text-13 font-semibold">
            Actions
          </h3>
          <span className="text-12 text-ink-2">
            <span className="tabular font-mono">{selectedCount}</span> selected
          </span>
        </div>
        <ul className="border border-rule bg-surface">
          {options.map((o, i) => (
            <OptionRow
              key={`${o.type}:${i}`}
              option={o}
              draft={drafts[i]!}
              onChange={(patch) => update(i, patch)}
              errors={validateDraft(o, drafts[i]!)}
              shown={(field, err) => shown(`${i}.${field}`, err)}
              onBlur={(field) => touch(`${i}.${field}`)}
            />
          ))}
        </ul>
      </fieldset>

      <div className="px-5 pt-4">
        <Field
          label="Rationale"
          aside={
            <span className="tabular font-mono">
              {rationale.trim().length} / {RATIONALE_MAX}
            </span>
          }
          hint={`What you checked and why this fixes it. At least ${RATIONALE_MIN} characters; shown to the approver and kept in the audit log.`}
          error={shown('rationale', rationaleErr)}
        >
          {(a) => (
            <Textarea
              {...a}
              rows={3}
              maxLength={RATIONALE_MAX + 200}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              onBlur={() => touch('rationale')}
              placeholder="Gateway shows CAPTURED and settlement includes the payment; the order failed because the captured webhook returned HTTP 500."
            />
          )}
        </Field>
      </div>

      <section aria-labelledby="preview-title" aria-live="polite" className="px-5 pt-2 pb-6">
        <PolicyPanel preview={preview.preview} settled={preview.settled} loading={preview.isFetching} error={preview.error} hasActions={actions !== null} selected={selectedCount} />
      </section>

      <div className="sticky bottom-0 mt-auto border-t border-rule bg-surface px-5 py-3">
        {propose.isError ? <ProposeError error={propose.error} /> : null}
        <div className="flex items-center justify-end gap-2">
          {blocked ? <p className="mr-auto text-12 text-bad">Policy blocks this proposal. Change the actions to continue.</p> : null}
          {!blocked && formValid === false && selectedCount > 0 && (submitted || touched.rationale) ? (
            <p className="mr-auto text-12 text-ink-2">Complete the highlighted fields to continue.</p>
          ) : null}
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit} aria-disabled={!canSubmit}>
            {label}
          </Button>
        </div>
      </div>
    </form>
  );
}

interface OptionRowProps {
  option: ActionOption;
  draft: Draft;
  errors: { amount?: string; reason?: string };
  onChange: (patch: Partial<Draft>) => void;
  shown: (field: 'amount' | 'reason', err: string | undefined) => string | null;
  onBlur: (field: 'amount' | 'reason') => void;
}

function OptionRow({ option: o, draft, errors, onChange, shown, onBlur }: OptionRowProps) {
  const meta = ACTION_META[o.type];
  const checkboxId = `opt-${o.type}`;
  const showAmount = draft.checked && o.editable.includes('amountMinor');
  const showReason = draft.checked && o.editable.includes('reason');
  return (
    <li className={cx('border-b border-rule px-3 py-2.5 last:border-b-0', draft.checked && o.available && 'bg-paper')}>
      <div className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-2">
        <input
          id={checkboxId}
          type="checkbox"
          checked={draft.checked && o.available}
          disabled={!o.available}
          onChange={(e) => onChange({ checked: e.target.checked })}
          aria-describedby={`${checkboxId}-summary`}
          className="mt-0.5 size-4 accent-[var(--accent)] disabled:cursor-not-allowed"
        />
        <div className="min-w-0">
          <label htmlFor={checkboxId} className={cx('flex flex-wrap items-center gap-2 text-13 font-medium', o.available ? 'cursor-pointer text-ink' : 'text-ink-2')}>
            {meta.label}
            {o.recommended ? <Tag tone="accent">RECOMMENDED</Tag> : null}
            {meta.moneyMoving ? <Tag tone="warn">MOVES MONEY</Tag> : null}
          </label>
          <p id={`${checkboxId}-summary`} className="mt-0.5 text-12 text-ink-2">
            {o.available ? <MonoIds text={o.summary} /> : <>Not available: {o.unavailableReason ?? 'preconditions not met.'}</>}
          </p>
        </div>
        <span className="pt-0.5 font-mono text-11 text-ink-2">{meta.actionClass}</span>
      </div>
      {showAmount || showReason ? (
        <div className="mt-2 ml-7 grid grid-cols-[248px_minmax(0,1fr)] gap-x-4">
          {showAmount ? (
            <Field
              label="Refund amount"
              hint={o.maxAmountMinor !== null ? `Up to ${formatMoney(o.maxAmountMinor)}` : undefined}
              error={shown('amount', errors.amount)}
            >
              {(a) => (
                <div className="relative">
                  <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 font-mono text-13 text-ink-2">
                    ₹
                  </span>
                  <Input
                    {...a}
                    mono
                    inputMode="decimal"
                    autoComplete="off"
                    value={draft.amount}
                    onChange={(e) => onChange({ amount: e.target.value })}
                    onBlur={() => onBlur('amount')}
                    className="w-full pl-5 text-right aria-[invalid=true]:border-bad"
                  />
                </div>
              )}
            </Field>
          ) : (
            <span />
          )}
          {showReason ? (
            <Field label="Reason" error={shown('reason', errors.reason)}>
              {(a) => (
                <Input
                  {...a}
                  value={draft.reason}
                  onChange={(e) => onChange({ reason: e.target.value })}
                  onBlur={() => onBlur('reason')}
                  className="w-full aria-[invalid=true]:border-bad"
                />
              )}
            </Field>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

interface PolicyPanelProps {
  preview: PolicyPreview | undefined;
  settled: boolean;
  loading: boolean;
  error: unknown;
  hasActions: boolean;
  selected: number;
}

const APPROVER_TEXT = { AUTO: 'Runs now. No approval needed.', BLOCKED: 'Cannot run as proposed.' } as const;

function PolicyPanel({ preview, settled, loading, error, hasActions, selected }: PolicyPanelProps) {
  return (
    <>
      <div className="flex items-baseline justify-between pb-2">
        <h3 id="preview-title" className="text-13 font-semibold">
          Policy preview
        </h3>
        {hasActions && (!settled || loading) ? <span className="text-12 text-ink-2">Checking policy</span> : null}
        {preview && settled ? <span className="font-mono text-12 text-ink-2">policy {preview.decision.version}</span> : null}
      </div>
      <div className={cx('border border-rule bg-surface', hasActions && !settled && 'opacity-70')}>
        {selected === 0 ? (
          <p className="px-3 py-3 text-13 text-ink-2">Select at least one action to see who must approve it.</p>
        ) : !hasActions && !preview ? (
          <p className="px-3 py-3 text-13 text-ink-2">Fix the highlighted fields to see the policy outcome.</p>
        ) : error && !preview ? (
          <p role="alert" className="px-3 py-3 text-13 text-bad">
            Could not preview policy. {error instanceof ApiError ? <span className="font-mono text-12">{error.code}</span> : null}
          </p>
        ) : !preview ? (
          <PolicyPanelSkeleton />
        ) : (
          <PreviewBody preview={preview} />
        )}
      </div>
    </>
  );
}

function PreviewBody({ preview }: { preview: PolicyPreview }) {
  const { decision, preconditionFailures, approverHint, attempt } = preview;
  return (
    <>
      <dl className="grid grid-cols-3 border-b border-rule">
        <div className="px-3 py-2">
          <dt className="text-12 text-ink-2">Tier</dt>
          <dd className="mt-1">
            <Tag tone={resolutionTone.tier(decision.tier)}>{decision.tier}</Tag>
          </dd>
        </div>
        <div className="border-l border-rule px-3 py-2">
          <dt className="text-12 text-ink-2">Money moved</dt>
          <dd className="mt-0.5 text-14">
            <Money minor={decision.moneyMovingMinor} />
          </dd>
        </div>
        <div className="border-l border-rule px-3 py-2">
          <dt className="text-12 text-ink-2">Risk · attempt</dt>
          <dd className="mt-0.5 font-mono text-13">
            {decision.riskTier} · {attempt}
          </dd>
        </div>
      </dl>
      <p className={cx('border-b border-rule px-3 py-2 text-13', decision.tier === 'BLOCKED' ? 'text-bad' : 'text-ink')}>
        {approverHint ?? (decision.tier === 'AUTO' || decision.tier === 'BLOCKED' ? APPROVER_TEXT[decision.tier] : 'Needs approval.')}
      </p>
      {preconditionFailures.length ? <Preconditions failures={preconditionFailures} /> : null}
      <div className="px-3 py-1">
        <PolicyReasons reasons={decision.reasons} />
      </div>
    </>
  );
}

function Preconditions({ failures }: { failures: readonly PreconditionFailure[] }) {
  return (
    <ul aria-label="Precondition failures" className="border-b border-rule bg-bad-weak px-3 py-2 text-13 text-bad">
      {failures.map((f) => (
        <li key={`${f.actionIndex}:${f.message}`} className="flex gap-2 py-0.5">
          <Tag tone="bad">PRECONDITION</Tag>
          <span>
            <span className="font-mono text-12">
              #{f.actionIndex + 1} {ACTION_META[f.type].label}
            </span>
            {' · '}
            {f.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PolicyPanelSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="grid grid-cols-3 border-b border-rule">
        {[0, 1, 2].map((i) => (
          <div key={i} className={cx('px-3 py-2', i > 0 && 'border-l border-rule')}>
            <Skeleton width={48} height={10} />
            <Skeleton width={72} height={16} className="mt-2" />
          </div>
        ))}
      </div>
      <div className="px-3 py-3">
        <Skeleton width="60%" />
        <Skeleton width="80%" className="mt-3" />
      </div>
    </div>
  );
}

function ProposeError({ error }: { error: unknown }) {
  const e = error instanceof ApiError ? error : null;
  const details = (e?.details ?? null) as { preconditionFailures?: PreconditionFailure[] } | null;
  const message =
    e?.status === 409
      ? 'Another resolution on this case is waiting for a decision. Decide it before proposing a new one.'
      : e?.code === 'POLICY_BLOCKED'
        ? 'Policy blocked this proposal when it was submitted.'
        : (e?.message ?? 'Could not submit the proposal.');
  return (
    <div role="alert" className="mb-3 border border-bad bg-bad-weak px-3 py-2 text-13 text-bad">
      <p>{message}</p>
      {details?.preconditionFailures?.length ? (
        <ul className="mt-1 text-12">
          {details.preconditionFailures.map((f) => (
            <li key={`${f.actionIndex}:${f.message}`}>
              #{f.actionIndex + 1} {ACTION_META[f.type].label}: {f.message}
            </li>
          ))}
        </ul>
      ) : null}
      {e ? (
        <p className="tabular mt-1 font-mono text-12 text-ink-2">
          {e.code} · HTTP {e.status}
          {e.requestId ? ` · request ${e.requestId}` : ''}
        </p>
      ) : null}
    </div>
  );
}
