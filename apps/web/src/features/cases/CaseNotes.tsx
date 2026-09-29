import { useState } from 'react';
import type { OperatorNoteItem } from '@payops/shared';
import { ageLabel } from '../../lib/format';
import { can } from '../../lib/permissions';
import { useUser } from '../../lib/session';
import { Button } from '../../ui/Button';
import { ErrorState } from '../../ui/ErrorState';
import { Field } from '../../ui/Field';
import { Skeleton } from '../../ui/Skeleton';
import { Textarea } from '../../ui/Textarea';
import { useAddNote, useCaseNotes } from '../workflow/api';

const MAX = 2000;

/** `ageLabel` says "now" inside a minute; a note reads better as "just now" than "now ago". */
export const noteAge = (iso: string, now: Date): string => {
  const a = ageLabel(iso, now);
  return a === 'now' ? 'just now' : `${a} ago`;
};

interface FormProps {
  pending: boolean;
  error: string | null;
  onSubmit: (text: string) => void;
}

/** Pure form: clears itself after a successful save because the parent remounts it with a new key. */
export function NoteForm({ pending, error, onSubmit }: FormProps) {
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const empty = text.trim().length === 0;
  return (
    <form
      className="space-y-3 px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!empty) onSubmit(text.trim());
      }}
    >
      <Field label="Add a note" hint="Visible to everyone on the team. Notes cannot be edited or deleted." error={touched && empty ? 'Write a note first.' : null} aside={`${text.length}/${MAX}`}>
        {(f) => <Textarea {...f} value={text} maxLength={MAX} onChange={(e) => setText(e.target.value)} />}
      </Field>
      {error ? <p role="alert" className="text-13 text-bad">{error}</p> : null}
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? 'Saving' : 'Save note'}
      </Button>
    </form>
  );
}

export function NoteList({ items, now = new Date() }: { items: readonly OperatorNoteItem[]; now?: Date }) {
  if (items.length === 0) return <p className="px-5 py-4 text-14 text-ink-2">No notes yet.</p>;
  return (
    <ul className="divide-y divide-rule">
      {items.map((n) => (
        <li key={n.id} className="px-5 py-3 text-14">
          <p className="whitespace-pre-wrap break-words text-ink">{n.text}</p>
          <p className="mt-1 text-12 text-ink-2">
            {n.authorName}, <time dateTime={n.createdAt}>{noteAge(n.createdAt, now)}</time>
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Notes panel on the case page. Everyone can read; OPS and above can write. */
export function CaseNotes({ caseId }: { caseId: string }) {
  const user = useUser();
  const list = useCaseNotes(caseId);
  const add = useAddNote(caseId);
  // Bumped after each save so the form remounts empty.
  const [saved, setSaved] = useState(0);

  return (
    <section aria-labelledby="notes-title" className="rounded-lg border border-rule bg-surface">
      <header className="flex min-h-12 items-center justify-between border-b border-rule px-5 py-2">
        <h2 id="notes-title" className="text-16 font-semibold">Notes</h2>
        {list.data ? <span className="tabular font-mono text-12 text-ink-2">{list.data.total}</span> : null}
      </header>
      {can(user?.role, 'note') ? (
        <NoteForm
          key={saved}
          pending={add.isPending}
          error={add.isError ? add.error.message : null}
          onSubmit={(text) => add.mutate({ text }, { onSuccess: () => setSaved((n) => n + 1) })}
        />
      ) : (
        <p className="px-5 py-4 text-14 text-ink-2">You have view access. Writing notes needs an Ops or manager account.</p>
      )}
      <div className="border-t border-rule">
        {list.isError ? (
          <ErrorState title="Could not load notes." error={list.error} onRetry={() => void list.refetch()} />
        ) : list.isPending ? (
          <div className="px-5 py-4" aria-hidden="true"><Skeleton height={44} width="100%" /></div>
        ) : (
          <NoteList items={list.data.items} />
        )}
      </div>
    </section>
  );
}
