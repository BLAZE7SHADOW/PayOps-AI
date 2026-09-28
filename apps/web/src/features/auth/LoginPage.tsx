import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import type { DemoAccount } from '@payops/shared';
import { ApiError } from '../../lib/api';
import { safeNext, useDemoAccounts, useDemoLogin, useLogin, useSession } from '../../lib/session';
import { useDocumentTitle } from '../../lib/use-document-title';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { Input } from '../../ui/Input';
import { Skeleton } from '../../ui/Skeleton';
import { Tag } from '../../ui/Tag';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailError(v: string): string | null {
  if (!v.trim()) return 'Enter your email.';
  if (!EMAIL_RE.test(v.trim())) return 'Enter an email like ops@payops.dev.';
  return null;
}
const passwordError = (v: string): string | null => (v ? null : 'Enter your password.');

function signInError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Email or password is incorrect.';
    if (err.status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (err.status === 0) return 'Could not reach the API server. Check that it is running.';
    return `${err.message} (${err.code})`;
  }
  return 'Sign in failed.';
}

/** Two fields and a button on paper; demo accounts as text buttons below (docs/05 §11 Sign in). */
export function LoginPage() {
  useDocumentTitle('Sign in');
  const session = useSession();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const login = useLogin();
  const demo = useDemoLogin();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState({ email: false, password: false });
  const [submitted, setSubmitted] = useState(false);

  if (session.data) return <Navigate to={next} replace />;

  const errors = { email: emailError(email), password: passwordError(password) };
  const show = (k: 'email' | 'password') => ((touched[k] || submitted) && errors[k]) || null;
  const busy = login.isPending || demo.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    demo.reset();
    if (errors.email || errors.password) return;
    login.mutate({ email: email.trim(), password }, { onSuccess: () => navigate(next, { replace: true }) });
  };

  return (
    <main className="min-h-screen bg-paper px-4 text-ink">
      <div className="mx-auto flex w-full max-w-[360px] flex-col pt-[18vh] pb-12">
        <h1 className="text-20 font-semibold tracking-[-0.005em]">
          PayOps <span className="font-normal text-ink-2">AI</span>
        </h1>
        <p className="mt-1 text-13 text-ink-2">Sign in to the payment operations console.</p>

        <form noValidate onSubmit={submit} className="mt-6 flex flex-col gap-1" aria-describedby="signin-error">
          <Field label="Email" error={show('email')}>
            {(a) => (
              <Input
                {...a}
                type="email"
                autoComplete="username"
                spellCheck={false}
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                className="h-9 w-full"
              />
            )}
          </Field>
          <Field label="Password" error={show('password')}>
            {(a) => (
              <Input
                {...a}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                className="h-9 w-full"
              />
            )}
          </Field>
          <Button type="submit" variant="primary" disabled={busy} className="mt-1 h-9 w-full">
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
          <p id="signin-error" role="alert" className="h-7 pt-2 text-13 text-bad">
            {login.isError ? signInError(login.error) : null}
          </p>
        </form>

        <DemoAccounts
          busy={busy}
          pendingEmail={demo.isPending ? demo.variables?.email : undefined}
          error={demo.isError ? signInError(demo.error) : null}
          onPick={(a) => {
            login.reset();
            demo.mutate({ email: a.email }, { onSuccess: () => navigate(next, { replace: true }) });
          }}
        />

        <p className="mt-10 flex items-center gap-2 text-12 text-ink-2">
          <Tag tone="warn">SIMULATED DATA</Tag>
          Demo system. All data is generated.
        </p>
      </div>
    </main>
  );
}

interface DemoAccountsProps {
  busy: boolean;
  pendingEmail: string | undefined;
  error: string | null;
  onPick: (a: DemoAccount) => void;
}

function DemoAccounts({ busy, pendingEmail, error, onPick }: DemoAccountsProps) {
  const q = useDemoAccounts();
  if (q.data && q.data.length === 0) return null;
  return (
    <section aria-labelledby="demo-title" className="mt-4 border-t border-rule pt-4">
      <h2 id="demo-title" className="text-12 font-medium text-ink-2">
        Demo accounts
      </h2>
      <ul className="mt-1 flex flex-col">
        {q.data
          ? q.data.map((a) => (
              <li key={a.email}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onPick(a)}
                  className="transition-color group flex h-8 w-full items-center justify-between gap-3 rounded-xs text-left text-13 text-accent hover:text-ink disabled:opacity-55"
                >
                  <span className="truncate">
                    {pendingEmail === a.email ? 'Signing in as ' : 'Continue as '}
                    {a.label}
                    <span className="text-ink-2"> · {a.name}</span>
                  </span>
                  <span className="shrink-0 font-mono text-11 text-ink-2">{a.role}</span>
                </button>
              </li>
            ))
          : [0, 1, 2, 3].map((i) => (
              <li key={i} className="flex h-8 items-center">
                <Skeleton width={i % 2 ? 200 : 240} />
              </li>
            ))}
      </ul>
      {error ? (
        <p role="alert" className="pt-1 text-13 text-bad">
          {error}
        </p>
      ) : null}
    </section>
  );
}
