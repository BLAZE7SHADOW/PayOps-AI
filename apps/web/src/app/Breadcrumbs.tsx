import { Fragment } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useCase } from '../features/cases/api';

const ROOT: Record<string, string> = {
  overview: 'Overview',
  payments: 'Payments',
  exceptions: 'Exceptions',
  cases: 'Exceptions',
  simulator: 'Simulator',
  audit: 'Audit log',
};

export function Breadcrumbs() {
  const { pathname } = useLocation();
  const { caseId } = useParams();
  const first = pathname.split('/')[1] ?? '';
  const root = ROOT[first];
  const crumbs: Array<{ label: string; to?: string; mono?: boolean }> = [];
  if (root) crumbs.push({ label: root, to: first === 'cases' ? '/exceptions' : undefined });
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-2 text-14">
        {crumbs.map((c, i) => (
          <Fragment key={c.label}>
            {i > 0 ? <li aria-hidden="true" className="text-ink-3">/</li> : null}
            <li className={c.to ? 'text-ink-2' : 'font-medium text-ink'}>
              {c.to ? (
                <Link to={c.to} className="transition-color hover:text-ink">
                  {c.label}
                </Link>
              ) : (
                c.label
              )}
            </li>
          </Fragment>
        ))}
        {first === 'cases' && caseId ? (
          <>
            <li aria-hidden="true" className="text-ink-3">
              /
            </li>
            <CaseCrumb caseId={caseId} />
          </>
        ) : null}
      </ol>
    </nav>
  );
}

/** Same query as the case page, so TanStack dedupes it into one request. */
function CaseCrumb({ caseId }: { caseId: string }) {
  const { data } = useCase(caseId);
  return (
    <li aria-current="page" className="tabular truncate font-mono text-13 font-medium text-ink">
      {data?.displayId ?? caseId}
    </li>
  );
}
