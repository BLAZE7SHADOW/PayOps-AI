/**
 * Saved queue views (P2 task 2, D068): a name plus a set of filters, private to one user.
 * Filters are stored as the operator set them; `assigneeId: 'me'` is resolved by the web app
 * when the view is applied, so a view saved by one person still means "mine" for that person.
 */
import { and, asc, count, eq } from 'drizzle-orm';
import { MAX_SAVED_VIEWS_PER_USER, newId, type SavedViewBody, type SavedViewItem } from '@payops/shared';
import type { Db } from '../db/client';
import { savedViews } from '../db/schema';
import { AppError, notFound } from '../errors';
import type { ClockPort } from '../ports/clock';

type ViewRow = typeof savedViews.$inferSelect;

const toItem = (r: ViewRow): SavedViewItem => ({ id: r.id, name: r.name, filters: r.filters, createdAt: r.createdAt.toISOString() });

/** Postgres unique violation, unwrapping Drizzle's error wrapper. */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

export class SavedViewService {
  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
  ) {}

  async list(ownerId: string): Promise<SavedViewItem[]> {
    const rows = await this.db.select().from(savedViews).where(eq(savedViews.ownerId, ownerId)).orderBy(asc(savedViews.createdAt), asc(savedViews.id));
    return rows.map(toItem);
  }

  async save(ownerId: string, body: SavedViewBody): Promise<SavedViewItem> {
    const [{ n } = { n: 0 }] = await this.db.select({ n: count() }).from(savedViews).where(eq(savedViews.ownerId, ownerId));
    if (n >= MAX_SAVED_VIEWS_PER_USER) {
      throw new AppError('CONFLICT', `You can keep up to ${MAX_SAVED_VIEWS_PER_USER} saved views. Delete one first.`);
    }
    try {
      const [row] = await this.db
        .insert(savedViews)
        .values({ id: newId('savedView'), ownerId, name: body.name.trim(), filters: body.filters, createdAt: this.clock.now() })
        .returning();
      if (!row) throw new Error('saved view insert returned no row');
      return toItem(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('CONFLICT', `You already have a view named "${body.name.trim()}".`);
      throw err;
    }
  }

  /** Only the owner can delete a view; anyone else gets NOT_FOUND so ids are not probeable. */
  async remove(ownerId: string, id: string): Promise<void> {
    const deleted = await this.db
      .delete(savedViews)
      .where(and(eq(savedViews.id, id), eq(savedViews.ownerId, ownerId)))
      .returning({ id: savedViews.id });
    if (deleted.length === 0) throw notFound('Saved view', id);
  }
}
