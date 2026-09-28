import { Link } from 'react-router';
import { CASE_TYPE_LABEL, formatMoney, type ApprovalDetail, type ApprovalItem } from '@payops/shared';
import type { ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { formatFullDateTime, statusLabel } from '../../lib/format';
import { resolutionTone } from '../../lib/resolution';
import { tone } from '../../lib/status';
import { useUser } from '../../lib/session';
import { Drawer } from '../../ui/Drawer';
import { ErrorState } from '../../ui/ErrorState';
import { MiniMatrix } from '../../ui/MiniMatrix';
import { Money } from '../../ui/Money';
import { Skeleton } from '../../ui/Skeleton';
import { Tag } from '../../ui/Tag';
import { ActionList, Actor, Ago, PolicyReasons, Quote, RuleIds } from '../resolution/parts';
import { VerificationTable } from '../resolution/VerificationTable';
import { useApproval, useDecide } from './api';
import { DecisionForm } from './DecisionForm';

interface Props {
  approvalId: string | undefined;
  onClose: () => void;
}

export function ApprovalDrawer({ approvalId, onClose }: Props) {
  const q = useApproval(approvalId);
  const a = q.data;
  return (
    <Drawer
      open={Boolean(approvalId)}
      onOpenChange={(o) => !o && onClose()}
      title={a ? `Approval for ${a.case.displayId}` : 'Approval'}
      width={720}
      footer={a && a.status === 'PENDING' ? <Decision key={a.id} a={a} /> : undefined}
    >
      {q.isError ? (
        <ErrorState className="pt-12" title="Could not load this approval." error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <Header a={a} />
          {a ? <Body a={a} /> : <BodySkeleton />}
        </>
      )}
    </Drawer>
  );
}

function Block({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="px-5 pt-5">
      <div className="flex items-baseline justify-between gap-3 pb-2">
        <h3 className="text-13 font-semibold">{title}</h3>
        {aside ? <span className="text-12 text-ink-2">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Header({ a }: { a: ApprovalDetail | undefined }) {
  return (
    <header className="border-b border-rule bg-surface px-5 pt-4 pb-4">
      <p className="flex items-center gap-2 text-12 text-ink-2">
        Approval
        {a ? (
          <>
            <Tag tone={resolutionTone.tier(a.tier)}>{a.tier}</Tag>
            <Tag tone={resolutionTone.approval(a.status)}>{a.status}</Tag>
          </>
        ) : null}
      </p>
      {a ? (
        <>
          <h2 className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pr-10 text-16">
            <Link to={`/cases/${a.case.id}`} className="link tabular font-mono font-semibold">
              {a.case.displayId}
            </Link>
            <span className="text-ink-3" aria-hidden="true">·</span>
            <span>{CASE_TYPE_LABEL[a.case.type]}</span>
            <span className="text-ink-3" aria-hidden="true">·</span>
            <Money minor={a.case.amountMinor} className="font-medium" />
            <span className="text-ink-3" aria-hidden="true">·</span>
            <MiniMatrix mismatched={a.caseItem.mismatched} />
            <Tag tone={tone.caseStatus(a.case.status)}>{statusLabel(a.case.status)}</Tag>
          </h2>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-13 text-ink-2">
            Requested by <Actor actor={a.requestedBy} /> <Ago iso={a.requestedAt} />
            <span aria-hidden="true" className="text-ink-3">·</span>
            <span>
              risk <span className="font-mono">{a.riskTier}</span>
            </span>
            {a.moneyMovingMinor ? (
              <>
                <span aria-hidden="true" className="text-ink-3">·</span>
                <span>
                  moves <Money minor={a.moneyMovingMinor} className="text-ink" />
                </span>
              </>
            ) : null}
          </p>
        </>
      ) : (
        <>
          <Skeleton width={320} height={16} className="mt-2" />
          <Skeleton width={280} className="mt-3" />
        </>
      )}
    </header>
  );
}

function Body({ a }: { a: ApprovalDetail }) {
  const r = a.resolution;
  return (
    <div className="pb-6">
      <Block title="Proposal" aside={`attempt ${r.attempt}`}>
        <div className="border border-rule bg-surface px-3">
          <ActionList actions={r.actions} />
        </div>
      </Block>
      <Block title="Rationale">
        <Quote>{r.rationale}</Quote>
      </Block>
      <Block title="Why approval is needed" aside={<span className="font-mono">policy {r.policy.version}</span>}>
        <div className="border border-rule bg-surface px-3 py-1">
          <PolicyReasons reasons={r.policy.reasons} />
        </div>
        <p className="mt-2 flex items-center gap-2 text-12 text-ink-2">
          Rules fired <RuleIds ids={a.ruleIds} reasons={r.policy.reasons} />
        </p>
      </Block>
      {a.status !== 'PENDING' ? <Outcome a={a} /> : null}
    </div>
  );
}

/** What happened after the decision, including the validator verdict once execution finishes. */
function Outcome({ a }: { a: ApprovalDetail }) {
  const r = a.resolution;
  return (
    <Block title="Outcome">
      <div className="flex flex-col gap-2 text-13">
        <p className="flex flex-wrap items-center gap-2">
          <Tag tone={resolutionTone.approval(a.status)}>{a.status}</Tag>
          {a.decidedBy ? (
            <span className="inline-flex items-center gap-1.5 text-ink-2">
              by <Actor actor={a.decidedBy} />
            </span>
          ) : null}
          {a.decidedAt ? (
            <time dateTime={a.decidedAt} className="tabular font-mono text-12 text-ink-2">
              {formatFullDateTime(a.decidedAt)}
            </time>
          ) : null}
        </p>
        {a.comment ? <Quote>{a.comment}</Quote> : null}
        {a.status === 'APPROVED' ? (
          r.validation ? (
            <div className="pt-1">
              <VerificationTable validation={r.validation} actions={r.actions} />
            </div>
          ) : (
            <p role="status" className="text-ink-2">
              {r.status === 'EXECUTION_FAILED'
                ? 'Execution failed. See the case for the failing step.'
                : 'Executing. The validator verdict appears here when it finishes.'}
            </p>
          )
        ) : null}
        <p>
          <Link to={`/cases/${a.case.id}`} className="link">
            Open {a.case.displayId}
          </Link>
        </p>
      </div>
    </Block>
  );
}

function Decision({ a }: { a: ApprovalItem }) {
  const user = useUser();
  const decide = useDecide(a.id, a.case.id);
  const conflict = decide.error instanceof ApiError && decide.error.status === 409;
  return (
    <div>
      {decide.isError ? (
        <p role="alert" className="mb-2 text-13 text-bad">
          {conflict ? 'Someone decided this approval first. Showing the latest state.' : (decide.error as Error).message}
          {decide.error instanceof ApiError ? <span className="ml-2 font-mono text-12 text-ink-2">{decide.error.code}</span> : null}
        </p>
      ) : null}
      <DecisionForm
        approval={a}
        role={user?.role}
        pending={decide.isPending ? (decide.variables?.decision ?? null) : null}
        onDecide={(decision, comment) => decide.mutate({ decision, comment })}
      />
      <span className="sr-only" aria-live="polite">
        {decide.isSuccess ? `Decision recorded: ${decide.data.status}. ${a.actionsSummary}, ${formatMoney(a.moneyMovingMinor)}.` : ''}
      </span>
    </div>
  );
}

function BodySkeleton() {
  return (
    <div aria-hidden="true" className="px-5 pt-5">
      <Skeleton width={72} height={12} />
      <Skeleton height={80} className="mt-3" />
      <Skeleton width={72} height={12} className="mt-6" />
      <Skeleton height={48} className="mt-3" />
      <Skeleton width={120} height={12} className="mt-6" />
      <Skeleton height={64} className="mt-3" />
    </div>
  );
}
