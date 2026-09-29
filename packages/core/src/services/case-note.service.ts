/**
 * Operator notes on a case (P2 task 2, D068). Append-only: a note cannot be edited or deleted,
 * so the case history stays trustworthy. Allowed on closed cases too, because follow-up
 * ("bank confirmed the refund") often lands after resolution.
 */
import { desc, eq } from 'drizzle-orm';
import { newId, type OperatorNoteBody, type OperatorNoteItem, type SessionUser } from '@payops/shared';
import type { Db } from '../db/client';
import { caseNotes, cases } from '../db/schema';
import { notFound } from '../errors';
import type { ClockPort } from '../ports/clock';
import { auditFrom, type AuditService } from './audit.service';

type NoteRow = typeof caseNotes.$inferSelect;

export const toNoteItem = (r: NoteRow): OperatorNoteItem => ({
  id: r.id,
  caseId: r.caseId,
  text: r.text,
  authorId: r.authorId,
  authorName: r.authorName,
  createdAt: r.createdAt.toISOString(),
});

export class CaseNoteService {
  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
    private readonly audit: AuditService,
  ) {}

  async add(caseId: string, body: OperatorNoteBody, user: Pick<SessionUser, 'id' | 'name'>): Promise<OperatorNoteItem> {
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select({ id: cases.id, displayId: cases.displayId }).from(cases).where(eq(cases.id, caseId)).limit(1);
      if (!c) throw notFound('Case', caseId);
      const text = body.text.trim();
      const [row] = await tx
        .insert(caseNotes)
        .values({ id: newId('note'), caseId, text, authorId: user.id, authorName: user.name, createdAt: this.clock.now() })
        .returning();
      if (!row) throw new Error('note insert returned no row');
      await this.audit.record(
        auditFrom(
          { actor: { actorType: 'USER', actorId: user.id, actorName: user.name }, caseId },
          {
            action: 'case.note_added',
            entityType: 'case',
            entityId: caseId,
            summary: `Added a note to ${c.displayId}`,
            after: { noteId: row.id },
          },
        ),
        tx,
      );
      return toNoteItem(row);
    });
  }

  /** Newest first. */
  async list(caseId: string): Promise<OperatorNoteItem[]> {
    const [c] = await this.db.select({ id: cases.id }).from(cases).where(eq(cases.id, caseId)).limit(1);
    if (!c) throw notFound('Case', caseId);
    const rows = await this.db.select().from(caseNotes).where(eq(caseNotes.caseId, caseId)).orderBy(desc(caseNotes.createdAt), desc(caseNotes.id));
    return rows.map(toNoteItem);
  }
}
