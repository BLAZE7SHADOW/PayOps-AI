/**
 * Operator feedback on a run's diagnosis (P1 task 3, D065). An operator says whether the
 * agent's root cause was right and, if not, why. It only records a judgment: it never changes
 * the run, the case or any later decision. Metrics (P5) and new root-cause checks (P1 task 2b)
 * are the intended readers.
 */
import { desc, eq } from 'drizzle-orm';
import { newId, type DiagnosisFeedbackBody, type DiagnosisFeedbackItem } from '@payops/shared';
import type { Db } from '../db/client';
import { agentRuns, diagnosisFeedback } from '../db/schema';
import { AppError } from '../errors';
import type { ClockPort } from '../ports/clock';
import { auditFrom, type AuditService } from './audit.service';

type FeedbackRow = typeof diagnosisFeedback.$inferSelect;

const toItem = (r: FeedbackRow): DiagnosisFeedbackItem => ({
  id: r.id,
  runId: r.runId,
  caseId: r.caseId,
  diagnosedRootCause: r.diagnosedRootCause,
  verdict: r.verdict,
  reason: r.reason,
  correctRootCause: r.correctRootCause,
  givenById: r.givenById,
  givenByName: r.givenByName,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export class FeedbackService {
  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
    private readonly audit: AuditService,
  ) {}

  /** Records the operator's verdict on a run. A second call from the same operator replaces the first. */
  async submit(runId: string, body: DiagnosisFeedbackBody, user: { id: string; name: string }): Promise<DiagnosisFeedbackItem> {
    return this.db.transaction(async (tx) => {
      const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
      if (!run) throw new AppError('NOT_FOUND', 'Run not found');
      if (!run.diagnosis) throw new AppError('CONFLICT', 'This run has no diagnosis to give feedback on yet.');

      const now = this.clock.now();
      // A RIGHT verdict has nothing to correct, so a stray corrected cause is dropped.
      const correctRootCause = body.verdict === 'WRONG' ? (body.correctRootCause ?? null) : null;
      const values = {
        diagnosedRootCause: run.diagnosis.rootCause,
        verdict: body.verdict,
        reason: body.reason,
        correctRootCause,
        givenByName: user.name,
        updatedAt: now,
      };
      const [row] = await tx
        .insert(diagnosisFeedback)
        .values({ id: newId('diagnosisFeedback'), runId, caseId: run.caseId, givenById: user.id, createdAt: now, ...values })
        .onConflictDoUpdate({ target: [diagnosisFeedback.runId, diagnosisFeedback.givenById], set: values })
        .returning();
      if (!row) throw new Error('feedback upsert returned no row');

      await this.audit.record(
        auditFrom(
          { actor: { actorType: 'USER', actorId: user.id, actorName: user.name }, caseId: run.caseId, runId },
          {
            action: 'diagnosis.feedback',
            entityType: 'run',
            entityId: runId,
            summary:
              body.verdict === 'RIGHT'
                ? `Marked the diagnosis ${run.diagnosis.rootCause} as right.`
                : `Marked the diagnosis ${run.diagnosis.rootCause} as wrong: ${body.reason}`,
            after: { verdict: body.verdict, correctRootCause },
          },
        ),
        tx,
      );
      return toItem(row);
    });
  }

  async listForRun(runId: string): Promise<DiagnosisFeedbackItem[]> {
    const rows = await this.db.select().from(diagnosisFeedback).where(eq(diagnosisFeedback.runId, runId)).orderBy(desc(diagnosisFeedback.updatedAt));
    return rows.map(toItem);
  }
}
