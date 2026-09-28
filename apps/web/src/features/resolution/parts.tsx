/** Small pieces shared by the case Resolution section and the approval drawer. */
import { ACTION_META, type ActorRef, type CatalogAction, type PolicyDecision, type PolicyReason } from '@payops/shared';
import { Fragment } from 'react';
import { ageLabel, formatFullDateTime } from '../../lib/format';
import { actionParams, resolutionTone, ruleCondition } from '../../lib/resolution';
import { Tag } from '../../ui/Tag';
import { Tooltip } from '../../ui/Tooltip';
import { cx } from '../../ui/cx';

/** A rule id in mono with its condition in a tooltip. Focusable so keyboard users can read it. */
export function RuleId({ id, reason }: { id: string; reason?: string }) {
  return (
    <Tooltip content={reason ? `${ruleCondition(id)}. ${reason}` : ruleCondition(id)}>
      <span tabIndex={0} className="cursor-help rounded-xs font-mono text-12 text-ink-2 underline decoration-rule-strong decoration-dotted underline-offset-4">
        {id}
      </span>
    </Tooltip>
  );
}

export function RuleIds({ ids, reasons }: { ids: readonly string[]; reasons?: readonly PolicyReason[] }) {
  if (ids.length === 0) return <span className="font-mono text-ink-3">–</span>;
  return (
    <span className="inline-flex flex-wrap gap-x-1.5">
      {ids.map((id, i) => (
        <Fragment key={id}>
          <RuleId id={id} reason={reasons?.find((r) => r.ruleId === id)?.reason} />
          {i < ids.length - 1 ? <span className="sr-only">,</span> : null}
        </Fragment>
      ))}
    </span>
  );
}

/** "Policy MANAGER · P2, P3 · risk HIGH" */
export function PolicySummary({ policy, className }: { policy: PolicyDecision; className?: string }) {
  const ids = [...new Set(policy.reasons.map((r) => r.ruleId))];
  return (
    <span className={cx('inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-12 text-ink-2', className)}>
      <span>Policy</span>
      <Tag tone={resolutionTone.tier(policy.tier)}>{policy.tier}</Tag>
      <RuleIds ids={ids} reasons={policy.reasons} />
      <span aria-hidden="true" className="text-ink-3">·</span>
      <span>
        risk <span className="font-mono">{policy.riskTier}</span>
      </span>
    </span>
  );
}

/** Every rule that fired: "P3 · Refunds over ₹10,000 → MANAGER", with the engine's reason under it. */
export function PolicyReasons({ reasons }: { reasons: readonly PolicyReason[] }) {
  if (reasons.length === 0) return <p className="text-13 text-ink-2">No rule fired.</p>;
  return (
    <ul className="flex flex-col">
      {reasons.map((r) => (
        <li key={`${r.ruleId}:${r.reason}`} className="grid grid-cols-[40px_minmax(0,1fr)_88px] items-baseline gap-2 border-b border-rule py-1.5 text-13 last:border-b-0">
          <span className="font-mono text-12 text-ink-2">{r.ruleId}</span>
          <span className="min-w-0">
            {ruleCondition(r.ruleId)}
            {r.reason ? <span className="block text-12 text-ink-2">{r.reason}</span> : null}
          </span>
          <span className="text-right">
            <span className="sr-only">tier </span>
            <Tag tone={resolutionTone.tier(r.tier)}>{r.tier}</Tag>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Numbered actions with their parameters in mono. */
export function ActionList({ actions }: { actions: readonly CatalogAction[] }) {
  return (
    <ol className="flex flex-col">
      {actions.map((a, i) => (
        <li key={i} className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-baseline gap-2 border-b border-rule py-2 text-13 last:border-b-0">
          <span className="tabular font-mono text-12 text-ink-2">{String(i + 1).padStart(2, '0')}</span>
          <span className="min-w-0">
            <span className="font-medium text-ink">{ACTION_META[a.type].label}</span>
            <span className="ml-2 font-mono text-11 text-ink-2">{a.type}</span>
            <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-12 text-ink-2">
              {actionParams(a).map((p) => (
                <span key={p.key} className="min-w-0 break-all">
                  {p.key}=<span className="text-ink">{p.value}</span>
                </span>
              ))}
            </span>
          </span>
          <span className="font-mono text-11 text-ink-2">{ACTION_META[a.type].actionClass}</span>
        </li>
      ))}
    </ol>
  );
}

/** Name plus USER / AGENT tag. */
export function Actor({ actor }: { actor: ActorRef }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-ink">{actor.name}</span>
      <Tag tone={actor.type === 'AGENT' ? 'accent' : 'neutral'}>{actor.type}</Tag>
    </span>
  );
}

export function Ago({ iso }: { iso: string }) {
  const age = ageLabel(iso);
  return (
    <time dateTime={iso} title={formatFullDateTime(iso)} className="tabular font-mono text-12 text-ink-2">
      {age === 'now' ? 'just now' : `${age} ago`}
    </time>
  );
}

/** Rationale and comments are people's words: always plain text, never markup. */
export function Quote({ children }: { children: string }) {
  return <blockquote className="border border-rule bg-surface-sunk px-3 py-2 text-13 break-words whitespace-pre-wrap text-ink">{children}</blockquote>;
}
