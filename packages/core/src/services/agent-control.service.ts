/**
 * The operator's switch for the agent (P1 task 4, D066). PAUSED stops new investigations and
 * keeps any in-flight fix for a person; PROPOSE_ONLY lets the agent investigate and propose but
 * every fix waits for a person. Policy rule P12 enforces it; this service only stores the setting.
 * The product works without the agent, so people are never affected by this switch.
 */
import { eq } from 'drizzle-orm';
import type { AgentControlBody, AgentControlItem, AgentControlMode } from '@payops/shared';
import type { Db, DbOrTx } from '../db/client';
import { agentControls } from '../db/schema';
import type { ClockPort } from '../ports/clock';
import { auditFrom, type AuditService } from './audit.service';

const ROW_ID = 'global';

/** The current mode. NORMAL when nobody has ever changed it. */
export async function readAgentControlMode(db: DbOrTx): Promise<AgentControlMode> {
  const [row] = await db.select({ mode: agentControls.mode }).from(agentControls).where(eq(agentControls.id, ROW_ID)).limit(1);
  return row?.mode ?? 'NORMAL';
}

export class AgentControlService {
  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<AgentControlItem> {
    const [row] = await this.db.select().from(agentControls).where(eq(agentControls.id, ROW_ID)).limit(1);
    if (!row) return { mode: 'NORMAL', reason: '', changedByName: null, changedAt: null };
    return { mode: row.mode, reason: row.reason, changedByName: row.changedByName, changedAt: row.updatedAt.toISOString() };
  }

  async set(body: AgentControlBody, user: { id: string; name: string }): Promise<AgentControlItem> {
    const now = this.clock.now();
    // Going back to NORMAL leaves nothing to explain, so an old reason is never shown by mistake.
    const reason = body.mode === 'NORMAL' ? '' : body.reason;
    await this.db.transaction(async (tx) => {
      const values = { mode: body.mode, reason, changedById: user.id, changedByName: user.name, updatedAt: now };
      await tx.insert(agentControls).values({ id: ROW_ID, ...values }).onConflictDoUpdate({ target: agentControls.id, set: values });
      await this.audit.record(
        auditFrom(
          { actor: { actorType: 'USER', actorId: user.id, actorName: user.name } },
          {
            action: 'agent.control_changed',
            entityType: 'agent',
            entityId: ROW_ID,
            summary: body.mode === 'NORMAL' ? 'Set the agent back to NORMAL.' : `Set the agent to ${body.mode}: ${reason}`,
            after: { mode: body.mode, reason },
          },
        ),
        tx,
      );
    });
    return this.get();
  }
}
