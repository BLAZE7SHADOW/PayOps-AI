import { useState, type FormEvent } from 'react';
import type { SessionInfo } from '@payops/shared';
import { ApiError } from '../../lib/api';
import { formatDateTime, formatFullDateTime, plural } from '../../lib/format';
import { useDocumentTitle } from '../../lib/use-document-title';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorState } from '../../ui/ErrorState';
import { Field } from '../../ui/Field';
import { Input } from '../../ui/Input';
import { Mono } from '../../ui/Mono';
import { PageHeader } from '../../ui/PageHeader';
import { Section } from '../../ui/Section';
import { Skeleton } from '../../ui/Skeleton';
import { Table, type Column } from '../../ui/Table';
import { Tag } from '../../ui/Tag';
import { useMfaDisable, useMfaEnable, useMfaSetup, useRevokeOtherSessions, useRevokeSession, useSecurity } from './api';
import { describeUserAgent, groupSecret } from './sessions';

function codeMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 422) return 'That code is not correct or has already been used. Wait for the next code and try again.';
    if (err.status === 429) return 'Too many incorrect codes. Wait a few minutes and try again.';
    return `${err.message} (${err.code})`;
  }
  return 'Something went wrong. Try again.';
}

export function SecurityPage() {
  useDocumentTitle('Security');
  const q = useSecurity();
  return (
    <div className="max-w-[960px]">
      <PageHeader title="Security" meta="Sign-in protection and the browsers signed in to your account." />
      {q.isError ? (
        <div className="border border-rule bg-surface">
          <ErrorState title="Could not load security settings." error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <MfaPanel loading={q.isPending} enabled={q.data?.mfaEnabled ?? false} recommended={q.data?.mfaRecommended ?? false} />
          <SessionsPanel loading={q.isPending} sessions={q.data?.sessions ?? []} />
        </div>
      )}
    </div>
  );
}

type MfaMode = 'idle' | 'setup' | 'disable';

export function MfaPanel({ loading, enabled, recommended }: { loading: boolean; enabled: boolean; recommended: boolean }) {
  const [mode, setMode] = useState<MfaMode>('idle');
  const [code, setCode] = useState('');
  const setup = useMfaSetup();
  const enable = useMfaEnable();
  const disable = useMfaDisable();

  const reset = () => {
    setMode('idle');
    setCode('');
    setup.reset();
    enable.reset();
    disable.reset();
  };

  const startSetup = () => {
    setCode('');
    enable.reset();
    setup.mutate(undefined, { onSuccess: () => setMode('setup') });
  };
  const confirm = (e: FormEvent) => {
    e.preventDefault();
    enable.mutate(code.trim(), { onSuccess: reset });
  };
  const turnOff = (e: FormEvent) => {
    e.preventDefault();
    disable.mutate(code.trim(), { onSuccess: reset });
  };
  const ready = code.replace(/\s/g, '').length === 6;

  return (
    <Section
      title="Two-step sign-in"
      titleId="mfa-title"
      className="border border-rule"
      aside={loading ? null : <Tag tone={enabled ? 'ok' : 'neutral'}>{enabled ? 'ON' : 'OFF'}</Tag>}
      bodyClassName="px-5 py-4"
    >
      {loading ? (
        <Skeleton width={320} />
      ) : mode === 'setup' && setup.data ? (
        <form noValidate onSubmit={confirm} className="flex max-w-[520px] flex-col gap-3">
          <p className="text-14 text-ink">
            In an authenticator app, add an account with this key, then type the 6-digit code it shows. The key is shown once.
          </p>
          <div>
            <p className="text-12 text-ink-2">Key</p>
            <Mono className="text-16 tracking-wide" aria-label="Setup key">{groupSecret(setup.data.secret)}</Mono>
          </div>
          <div>
            <p className="text-12 text-ink-2">Setup link, for apps that open links</p>
            <Mono className="text-12 break-all">{setup.data.otpauthUrl}</Mono>
          </div>
          <Field label="6-digit code" error={enable.isError ? codeMessage(enable.error) : null}>
            {(a) => <Input {...a} mono inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} className="w-40" />}
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={!ready || enable.isPending}>
              {enable.isPending ? 'Checking' : 'Confirm and turn on'}
            </Button>
            <Button variant="quiet" disabled={enable.isPending} onClick={reset}>
              Cancel
            </Button>
          </div>
        </form>
      ) : enabled ? (
        mode === 'disable' ? (
          <form noValidate onSubmit={turnOff} className="flex max-w-[520px] flex-col gap-2">
            <p className="text-14 text-ink">Enter a current code to turn two-step sign-in off.</p>
            <Field label="6-digit code" error={disable.isError ? codeMessage(disable.error) : null}>
              {(a) => <Input {...a} mono inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} className="w-40" />}
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="danger-solid" disabled={!ready || disable.isPending}>
                {disable.isPending ? 'Checking' : 'Turn off'}
              </Button>
              <Button variant="quiet" disabled={disable.isPending} onClick={reset}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-14 text-ink">Signing in needs a code from your authenticator app as well as your password.</p>
            <Button variant="danger" onClick={() => setMode('disable')}>
              Turn off
            </Button>
          </div>
        )
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="max-w-[560px]">
            <p className="text-14 text-ink">Ask for a code from an authenticator app when you sign in, so a stolen password is not enough.</p>
            {recommended ? <p className="mt-1 text-13 text-warn">Your role approves higher-risk actions. Turn this on.</p> : null}
            {setup.isError ? (
              <p role="alert" className="mt-1 text-13 text-bad">
                {codeMessage(setup.error)}
              </p>
            ) : null}
          </div>
          <Button variant="primary" disabled={setup.isPending} onClick={startSetup}>
            {setup.isPending ? 'Preparing' : 'Turn on'}
          </Button>
        </div>
      )}
    </Section>
  );
}

export function SessionsPanel({ loading, sessions }: { loading: boolean; sessions: SessionInfo[] }) {
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const others = sessions.filter((s) => !s.current).length;

  const columns: Column<SessionInfo>[] = [
    {
      key: 'device',
      header: 'Browser',
      render: (s) => (
        <span className="flex items-center gap-2">
          <span className="truncate text-14 text-ink">{describeUserAgent(s.userAgent)}</span>
          {s.current ? <Tag tone="accent">THIS DEVICE</Tag> : null}
        </span>
      ),
      skeleton: 160,
    },
    { key: 'ip', header: 'IP address', width: 150, render: (s) => <Mono className="text-12">{s.ip || 'unknown'}</Mono>, skeleton: 96 },
    {
      key: 'signedIn',
      header: 'Signed in',
      width: 152,
      render: (s) => (
        <time dateTime={s.createdAt} title={formatFullDateTime(s.createdAt)} className="tabular font-mono text-12 text-ink-2">
          {formatDateTime(s.createdAt)}
        </time>
      ),
      skeleton: 112,
    },
    {
      key: 'lastSeen',
      header: 'Last active',
      width: 152,
      render: (s) => (
        <time dateTime={s.lastSeenAt} title={formatFullDateTime(s.lastSeenAt)} className="tabular font-mono text-12 text-ink-2">
          {formatDateTime(s.lastSeenAt)}
        </time>
      ),
      skeleton: 112,
    },
    { key: 'code', header: 'Used a code', width: 108, render: (s) => <span className="text-13 text-ink-2">{s.mfaVerified ? 'Yes' : 'No'}</span>, skeleton: 32 },
    {
      key: 'action',
      header: '',
      width: 96,
      align: 'right',
      render: (s) =>
        s.current ? null : (
          <Button size="sm" variant="quiet" disabled={revoke.isPending} aria-label={`Sign out ${describeUserAgent(s.userAgent)} from ${s.ip || 'unknown address'}`} onClick={() => revoke.mutate(s.id)}>
            Sign out
          </Button>
        ),
      skeleton: 56,
    },
  ];

  return (
    <Section
      title="Signed-in browsers"
      titleId="sessions-title"
      className="border border-rule"
      aside={
        <Button size="sm" disabled={loading || others === 0 || revokeOthers.isPending} onClick={() => revokeOthers.mutate(undefined)}>
          {others > 0 ? `Sign out ${plural(others, 'other browser')}` : 'No other browsers'}
        </Button>
      }
    >
      <Table<SessionInfo>
        label="Signed-in browsers"
        columns={columns}
        rows={sessions}
        rowKey={(s) => s.id}
        loading={loading}
        skeletonRows={3}
        minWidth={760}
        empty={<EmptyState message="No active sessions." />}
      />
      {revoke.isError || revokeOthers.isError ? (
        <p role="alert" className="px-5 py-3 text-13 text-bad">
          Could not sign the browser out. Try again.
        </p>
      ) : null}
    </Section>
  );
}
