import { Link, isRouteErrorResponse, useRouteError } from 'react-router';
import { useDocumentTitle } from '../lib/use-document-title';
import { ErrorState } from '../ui/ErrorState';

export function RouteError() {
  const err = useRouteError();
  useDocumentTitle('Error');
  const message = isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : err;
  return (
    <main className="min-h-screen bg-paper p-6">
      <ErrorState title="This screen failed to render." error={message instanceof Error ? message : new Error(String(message))} onRetry={() => window.location.reload()} />
    </main>
  );
}

export function NotFound() {
  useDocumentTitle('Not found');
  return (
    <p className="py-8 text-13 text-ink-2">
      No page at this address.{' '}
      <Link to="/overview" className="link">
        Go to Overview
      </Link>
    </p>
  );
}
