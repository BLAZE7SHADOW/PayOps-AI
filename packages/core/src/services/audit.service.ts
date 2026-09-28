import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { newId, type ActorType, type AuditEventItem, type AuditListQuery, type Page } from '@payops/shared';
import type { Db, DbOrTx } from '../db/client';
import type { AuditEventRow } from '../db/rows';
import { auditEvents } from '../db/schema';
import type { ClockPort } from '../ports/clock';
import { decodeCursor, encodeCursor, isRecord } from './cursor';

export interface AuditInput {
  actorType: ActorType;
  actorId: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  caseId?: string | null;
  runId?: string | null;
}

/** The actor used for automated detection and background jobs. */
export const SYSTEM_ACTOR = { actorType: 'SYSTEM', actorId: 'system', actorName: 'Reconciliation' } as const;

export interface AuditActor {
  actorType: ActorType;
  actorId: string;
  actorName: string;
}

/**
 * Who is making a write and on behalf of which case/run. Every write service takes one so its
 * audit rows land in the case's trail.
 */
export interface WriteContext {
  actor: AuditActor;
  caseId?: string | null;
  runId?: string | null;
}

export const WEBHOOK_CONSUMER_ACTOR: AuditActor = {
  actorType: 'SYSTEM',
  actorId: 'webhook-consumer',
  actorName: 'Webhook consumer',
};

/** Convenience for writing an audit row from a WriteContext. */
export function auditFrom(
  ctx: WriteContext,
  fields: Omit<AuditInput, 'actorType' | 'actorId' | 'actorName' | 'caseId' | 'runId'>,
): AuditInput {
  return { ...ctx.actor, caseId: ctx.caseId ?? null, runId: ctx.runId ?? null, ...fields };
}

interface AuditCursor {
  at: string;
  id: string;
}
const isAuditCursor = (v: unknown): v is AuditCursor =>
  isRecord(v) && typeof v.at === 'string' && typeof v.id === 'string';

/** Append-only audit trail. Pass `tx` so the audit row commits with the change it describes. */
export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
  ) {}

  async record(input: AuditInput, tx?: DbOrTx): Promise<void> {
    await (tx ?? this.db).insert(auditEvents).values({
      id: newId('audit'),
      at: this.clock.now(),
      actorType: input.actorType,
      actorId: input.actorId,
      actorName: input.actorName,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      summary: input.summary,
      before: input.before ?? null,
      after: input.after ?? null,
      caseId: input.caseId ?? null,
      runId: input.runId ?? null,
    });
  }

  /** Newest first, keyset-paginated on (at, id). */
  async list(query: AuditListQuery): Promise<Page<AuditEventItem>> {
    const conds: SQL[] = [];
    if (query.caseId) conds.push(eq(auditEvents.caseId, query.caseId));
    if (query.entityId) conds.push(eq(auditEvents.entityId, query.entityId));
    const cursor = decodeCursor(query.cursor, isAuditCursor);
    if (cursor) {
      const at = new Date(cursor.at);
      conds.push(or(lt(auditEvents.at, at), and(eq(auditEvents.at, at), lt(auditEvents.id, cursor.id))) as SQL);
    }
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditEvents.at), desc(auditEvents.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toAuditItem),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ at: last.at.toISOString(), id: last.id }) : null,
    };
  }
}

export function toAuditItem(r: AuditEventRow): AuditEventItem {
  return {
    id: r.id,
    at: r.at.toISOString(),
    actorType: r.actorType,
    actor: { id: r.actorId, name: r.actorName },
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    summary: r.summary,
    runId: r.runId,
  };
}
