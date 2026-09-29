import { useState } from 'react';
import type { SavedViewFilters, SavedViewItem } from '@payops/shared';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';

interface Props {
  views: readonly SavedViewItem[];
  /** The saved view whose filters match the page right now, if any. */
  activeId: string | undefined;
  /** True when the page has at least one filter worth saving. */
  canSave: boolean;
  pending: boolean;
  error: string | null;
  onApply: (filters: SavedViewFilters) => void;
  onSave: (name: string) => void;
  onDelete: (id: string) => void;
}

/** Saved views control for the Exceptions filter bar. Pure: the page owns queries and the URL. */
export function SavedViews({ views, activeId, canSave, pending, error, onApply, onSave, onDelete }: Props) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const options = views.map((v) => ({ value: v.id, label: v.name }));
  const empty = name.trim().length === 0;

  if (naming) {
    return (
      <form
        className="inline-flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (empty) return;
          onSave(name.trim());
          setNaming(false);
          setName('');
        }}
      >
        <label htmlFor="view-name" className="sr-only">
          View name
        </label>
        <Input id="view-name" value={name} maxLength={60} placeholder="Name this view" autoFocus onChange={(e) => setName(e.target.value)} className="w-48" />
        <Button type="submit" variant="primary" disabled={empty || pending}>
          Save view
        </Button>
        <Button
          onClick={() => {
            setNaming(false);
            setName('');
          }}
        >
          Cancel
        </Button>
      </form>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {views.length > 0 ? (
        <Select
          label="Saved view"
          allLabel="Saved views"
          value={activeId}
          options={options}
          onChange={(id) => {
            const view = views.find((v) => v.id === id);
            if (view) onApply(view.filters);
          }}
          width={176}
        />
      ) : null}
      {activeId ? (
        <Button variant="quiet" disabled={pending} onClick={() => onDelete(activeId)}>
          Delete view
        </Button>
      ) : canSave ? (
        <Button variant="quiet" onClick={() => setNaming(true)}>
          Save as view
        </Button>
      ) : null}
      {error ? (
        <span role="alert" className="text-13 text-bad">
          {error}
        </span>
      ) : null}
    </span>
  );
}
