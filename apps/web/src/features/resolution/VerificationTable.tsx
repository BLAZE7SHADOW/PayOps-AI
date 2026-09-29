import { ACTION_META, type CatalogAction, type ValidationCheck, type ValidationResultDto } from '@payops/shared';
import { formatFullDateTime, formatTime } from '../../lib/format';
import { resolutionTone, verdictDetail } from '../../lib/resolution';
import { Tag } from '../../ui/Tag';
import { cx } from '../../ui/cx';

const GROUPS: Array<{ kind: ValidationCheck['kind']; title: string }> = [
  { kind: 'POSTCONDITION', title: 'Action postconditions' },
  { kind: 'INVARIANT', title: 'Case invariants' },
];

/**
 * Every validator check as a row (docs/05 §11): Check · Expected · Actual · Result.
 * Grouped into action postconditions then case invariants. A failed row gets the bad tint and a
 * FAIL tag, so the result never depends on color alone.
 */
export function VerificationTable({ validation, actions }: { validation: ValidationResultDto; actions?: readonly CatalogAction[] }) {
  const { verdict, checks } = validation;
  return (
    <div>
      <p className="flex h-9 items-center gap-2 text-13">
        <span className="font-medium text-ink">Verified:</span>
        <Tag tone={resolutionTone.verdict(verdict)}>{verdict}</Tag>
        <span className="text-ink-2">· {verdictDetail(checks)}</span>
        <time dateTime={validation.at} title={formatFullDateTime(validation.at)} className="tabular ml-auto font-mono text-12 text-ink-2">
          {formatTime(validation.at)}
        </time>
      </p>
      <table aria-label="Verification checks" className="w-full table-fixed border-separate border-spacing-0 border-x border-t border-rule bg-surface text-13">
        <colgroup>
          <col />
          <col style={{ width: '22%' }} />
          <col style={{ width: '22%' }} />
          <col style={{ width: 96 }} />
        </colgroup>
        <thead>
          <tr>
            {['Check', 'Expected', 'Actual', 'Result'].map((h) => (
              <th key={h} scope="col" className="h-8 border-b border-rule bg-surface-sunk px-3 text-left text-12 font-medium text-ink-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        {GROUPS.map((g) => {
          const rows = checks.filter((c) => c.kind === g.kind);
          if (rows.length === 0) return null;
          return (
            <tbody key={g.kind}>
              <tr>
                <td colSpan={4} className="h-7 border-b border-rule bg-paper px-3 text-left text-12 font-medium text-ink-2">
                  {g.title}
                </td>
              </tr>
              {rows.map((c) => (
                <CheckRow key={c.id} check={c} action={c.actionIndex !== null ? actions?.[c.actionIndex] : undefined} />
              ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

function CheckRow({ check, action }: { check: ValidationCheck; action: CatalogAction | undefined }) {
  const fail = !check.pass;
  const cell = cx('border-b border-rule px-3 py-1.5 align-top', fail && 'bg-bad-weak');
  return (
    <tr data-result={fail ? 'FAIL' : 'PASS'}>
      <td className={cell}>
        <span className="block truncate font-mono text-12 text-ink" title={check.subject}>
          {check.subject}
        </span>
        <span className="block text-12 text-ink-2">
          {check.actionIndex !== null ? (
            <span className="tabular font-mono">
              #{check.actionIndex + 1}
              {action ? ` ${ACTION_META[action.type].label}` : ''} ·{' '}
            </span>
          ) : null}
          {check.description}
        </span>
      </td>
      <td className={cx(cell, 'font-mono text-12 break-words text-ink')}>{check.expected}</td>
      <td className={cx(cell, 'font-mono text-12 break-words', fail ? 'font-medium text-bad' : 'text-ink')}>{check.actual}</td>
      <td className={cell}>
        <Tag tone={fail ? 'bad' : 'ok'}>{fail ? 'FAIL' : 'PASS'}</Tag>
      </td>
    </tr>
  );
}
