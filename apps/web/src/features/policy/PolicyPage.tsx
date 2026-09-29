import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PolicyDocument, PolicyRuleInfo, PolicyTier } from '@payops/shared';
import { api } from '../../lib/api';
import { qk } from '../../lib/query-keys';
import { resolutionTone } from '../../lib/resolution';
import { useDocumentTitle } from '../../lib/use-document-title';
import { AgentControlPanel } from '../agent-control/AgentControl';
import { ErrorState } from '../../ui/ErrorState';
import { PageHeader } from '../../ui/PageHeader';
import { Skeleton } from '../../ui/Skeleton';
import { Table, type Column } from '../../ui/Table';
import { Tag } from '../../ui/Tag';

function usePolicy() {
  return useQuery({ queryKey: qk.policy(), queryFn: ({ signal }) => api<PolicyDocument>('/api/policy', { signal }), staleTime: Infinity });
}

const tierTone = (t: PolicyRuleInfo['tier']) => (t === 'at least OPS' ? 'warn' : resolutionTone.tier(t));

const columns: Column<PolicyRuleInfo>[] = [
  { key: 'id', header: 'Rule', width: 72, render: (r) => <span className="font-mono">{r.id}</span>, skeleton: 24 },
  {
    key: 'condition',
    header: 'Condition',
    render: (r) => (
      <span className="block truncate" title={r.condition}>
        {r.condition}
      </span>
    ),
    skeleton: '70%',
  },
  { key: 'tier', header: 'Tier', width: 144, render: (r) => <Tag tone={tierTone(r.tier)}>{r.tier}</Tag>, skeleton: 64 },
  {
    key: 'applies',
    header: 'Applies to',
    width: 160,
    render: (r) => <span className="text-ink-2">{r.appliesTo === 'agent' ? 'Agent proposals only' : 'People and agent'}</span>,
    skeleton: 96,
  },
];

/** Read-only view of the rules code applies to every proposal (docs/05 §11 Policy). */
export function PolicyPage() {
  useDocumentTitle('Policy');
  const q = usePolicy();
  const doc = q.data;
  return (
    <>
      <PageHeader
        title="Policy"
        meta="Authority lives in code. Models and people propose; these rules decide who must approve."
        actions={
          <span className="text-12 text-ink-2">
            Version{' '}
            {doc ? <span className="tabular font-mono text-13 text-ink">{doc.version}</span> : <Skeleton width={96} className="inline-block align-middle" />}
          </span>
        }
      />
      {q.isError ? (
        <div className="border border-rule bg-surface">
          <ErrorState title="Could not load the policy." error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : (
        <>
          <Table<PolicyRuleInfo> label="Policy rules" columns={columns} rows={doc ? [...doc.rules] : []} rowKey={(r) => r.id} loading={!doc} skeletonRows={11} />
          <p className="mt-2 max-w-[72ch] text-12 text-ink-2">
            Every rule that matches is recorded; the strictest tier wins. BLOCKED proposals cannot be approved by anyone.
          </p>
          <AgentControlPanel />
          <div className="mt-6 grid grid-cols-12 gap-6">
            <section aria-labelledby="thresholds-title" className="col-span-7 min-w-0">
              <h2 id="thresholds-title" className="flex h-10 items-center text-13 font-semibold">
                Thresholds
              </h2>
              <List rows={doc?.thresholds.map((t) => ({ key: t.label, label: t.label, value: <span className="tabular font-mono">{t.value}</span> }))} />
            </section>
            <section aria-labelledby="approvers-title" className="col-span-5 min-w-0">
              <h2 id="approvers-title" className="flex h-10 items-center text-13 font-semibold">
                Who approves
              </h2>
              <List
                rows={doc?.approverRoles.map((a) => ({
                  key: a.tier,
                  label: <Tag tone={resolutionTone.tier(a.tier as PolicyTier)}>{a.tier}</Tag>,
                  value: a.approver,
                }))}
              />
            </section>
          </div>
        </>
      )}
    </>
  );
}

interface Row {
  key: string;
  label: ReactNode;
  value: ReactNode;
}

function List({ rows }: { rows: Row[] | undefined }) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] border border-b-0 border-rule bg-surface text-13">
      {rows
        ? rows.map((r) => (
            <div key={r.key} className="contents">
              <dt className="flex h-9 items-center border-b border-rule px-3 text-ink">{r.label}</dt>
              <dd className="flex h-9 items-center justify-end border-b border-rule px-3 text-right text-ink">{r.value}</dd>
            </div>
          ))
        : [0, 1, 2, 3].map((i) => (
            <div key={i} className="contents">
              <span className="flex h-9 items-center border-b border-rule px-3">
                <Skeleton width={180} />
              </span>
              <span className="flex h-9 items-center justify-end border-b border-rule px-3">
                <Skeleton width={64} />
              </span>
            </div>
          ))}
    </dl>
  );
}
