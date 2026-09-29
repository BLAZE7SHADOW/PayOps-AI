import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OperatorNoteItem } from '@payops/shared';
import { describe, expect, it, vi } from 'vitest';
import { NoteForm, NoteList, noteAge } from './CaseNotes';

const now = new Date('2026-09-28T12:00:00.000Z');
const note = (o: Partial<OperatorNoteItem>): OperatorNoteItem => ({
  id: 'note_1',
  caseId: 'case_1',
  text: 'Called the merchant.',
  authorId: 'usr_1',
  authorName: 'Ananya Rao',
  createdAt: '2026-09-28T09:00:00.000Z',
  ...o,
});

describe('NoteForm', () => {
  it('will not save an empty note and says why', async () => {
    const onSubmit = vi.fn();
    render(<NoteForm pending={false} error={null} onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText('Add a note'), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Write a note first.')).toBeVisible();
  });

  it('submits the trimmed text', async () => {
    const onSubmit = vi.fn();
    render(<NoteForm pending={false} error={null} onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText('Add a note'), '  Bank confirmed.  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(onSubmit).toHaveBeenCalledWith('Bank confirmed.');
  });

  it('disables saving while pending and shows an error', () => {
    render(<NoteForm pending error="Request failed." onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Saving' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed.');
  });
});

describe('NoteList', () => {
  it('says when there are no notes', () => {
    render(<NoteList items={[]} now={now} />);
    expect(screen.getByText('No notes yet.')).toBeVisible();
  });

  it('shows text, author and age, keeping line breaks', () => {
    render(<NoteList items={[note({ text: 'Line one\nLine two' })]} now={now} />);
    expect(screen.getByText(/Line one/)).toHaveClass('whitespace-pre-wrap');
    expect(screen.getByText(/Ananya Rao/)).toBeVisible();
    expect(screen.getByText('3h ago')).toBeVisible();
  });
});

describe('noteAge', () => {
  it('reads "just now" inside a minute', () => {
    expect(noteAge('2026-09-28T11:59:40.000Z', now)).toBe('just now');
    expect(noteAge('2026-09-28T11:30:00.000Z', now)).toBe('30m ago');
  });
});
