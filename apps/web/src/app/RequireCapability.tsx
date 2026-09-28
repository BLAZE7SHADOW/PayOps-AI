import type { ReactNode } from 'react';
import { can, type Capability } from '../lib/permissions';
import { useUser } from '../lib/session';
import { useDocumentTitle } from '../lib/use-document-title';

/** Screens a role cannot use say so plainly instead of rendering controls that would 403. */
export function RequireCapability({ capability, children }: { capability: Capability; children: ReactNode }) {
  const user = useUser();
  if (can(user?.role, capability)) return <>{children}</>;
  return <NoAccess />;
}

function NoAccess() {
  useDocumentTitle('No access');
  return (
    <div role="alert" className="border border-rule bg-surface px-4 py-6">
      <p className="text-14 font-medium text-ink">You do not have access to this.</p>
      <p className="tabular mt-2 font-mono text-12 text-ink-2">
        <span className="text-bad">FORBIDDEN</span> · HTTP 403
      </p>
    </div>
  );
}
