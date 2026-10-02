import { and, asc, desc, eq, gt, lt, or, type SQL } from 'drizzle-orm';
import { newId, type ActorType, type AuditChainStatus, type AuditEventItem, type AuditListQuery, type Page } from '@payops/shared';
import type { Db, DbOrTx } from '../db/client';
import type { AuditEventRow } from '../db/rows';
import { auditEvents } from '../db/schema';
import type { ClockPort } from '../ports/clock';
import { GENESIS_HASH, verifyAuditChain } from '../audit/chain';
import { csvLine } from '../audit/csv';
import { appendAuditRow, readChainPage, toChainRow } from '../audit/store';
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

const VERIFY_PAGE = 1000;
const EXPORT_COLUMNS = ['seq', 'id', 'at', 'actor_type', 'actor_id', 'actor_name', 'action', 'entity_type', 'entity_id', 'case_id', 'run_id', 'summary', 'before', 'after', 'prev_hash', 'hash'];

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
    const row = {
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
    };
    // The chain needs a transaction for its lock. Callers already in one pass `tx`; others get their own.
    if (tx) await appendAuditRow(tx, row);
    else await this.db.transaction((t) => appendAuditRow(t, row));
  }

  /** Walks the whole chain in seq order and reports the first broken row (D077). */
  async verifyChain(expectedHead?: { seq: number; hash: string }): Promise<AuditChainStatus> {
    let after: { seq: number; hash: string } | undefined;
    let checked = 0;
    for (;;) {
      const page = await readChainPage(this.db, after?.seq ?? 0, VERIFY_PAGE);
      if (page.length === 0) break;
      const verdict = verifyAuditChain(page.map(toChainRow), after ? { startAfter: after } : {});
      checked += verdict.checked;
      if (!verdict.ok) {
        return { ok: false, checked, head: after ?? null, brokenAtSeq: verdict.seq, brokenId: verdict.id, reason: verdict.reason };
      }
      const last = page[page.length - 1]!;
      after = { seq: last.seq, hash: last.hash };
      if (page.length < VERIFY_PAGE) break;
    }
    if (expectedHead) {
      const v = verifyAuditChain([], { startAfter: after ?? { seq: 0, hash: GENESIS_HASH }, expectedHead });
      if (!v.ok) return { ok: false, checked, head: after ?? null, brokenAtSeq: null, brokenId: null, reason: v.reason };
    }
    return { ok: true, checked, head: after ?? null, brokenAtSeq: null, brokenId: null, reason: null };
  }

  /** CSV lines for the whole log (or one case / entity), oldest first, a page at a time so memory stays flat. */
  async *exportCsv(filter: { caseId?: string; entityId?: string } = {}): AsyncGenerator<string> {
    yield csvLine(EXPORT_COLUMNS);
    let afterSeq = 0;
    for (;;) {
      const rows = await this.db
        .select()
        .from(auditEvents)
        .where(
          and(
            gt(auditEvents.seq, afterSeq),
            filter.caseId ? eq(auditEvents.caseId, filter.caseId) : undefined,
            filter.entityId ? eq(auditEvents.entityId, filter.entityId) : undefined,
          ),
        )
        .orderBy(asc(auditEvents.seq))
        .limit(VERIFY_PAGE);
      if (rows.length === 0) return;
      for (const r of rows) {
        yield csvLine([
          r.seq, r.id, r.at.toISOString(), r.actorType, r.actorId, r.actorName, r.action, r.entityType,
          r.entityId, r.caseId, r.runId, r.summary, r.before, r.after, r.prevHash, r.hash,
        ]);
      }
      afterSeq = rows[rows.length - 1]!.seq;
      if (rows.length < VERIFY_PAGE) return;
    }
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
