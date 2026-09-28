/**
 * Orchestrates one resolution attempt: preview → propose → (approval) → execute → validate → close.
 * People use it today; the Phase 3 agent will propose through the same path with its own
 * confidence and grounding inputs. Every step is a short transaction of its own, so nothing holds
 * a transaction while the gateway (and through it, our webhook consumer) runs.
 */
import { count, eq } from 'drizzle-orm';
import {
  ACTION_META,
  OPS_EVENTS,
  ProposeActionsBody,
  ROOMS,
  type PreconditionFailure,
  formatMoney,
  newId,
  roleAtLeast,
  type ActorRef,
  type ApprovalItem,
  type CatalogAction,
  type PolicyPreview,
  type ResolutionItem,
  type ResolutionStatus,
  type SessionUser,
} from '@payops/shared';
import type { Db } from '../db/client';
import type { CaseRow, ResolutionRow } from '../db/rows';
import { approvals, cases, resolutions } from '../db/schema';
import { AppError, notFound } from '../errors';
import type { ClockPort } from '../ports/clock';
import type { EventPublisherPort } from '../ports/events';
import type { PaymentGatewayPort } from '../ports/gateway';
import { checkPreconditions } from '../actions/registry';
import { loadCaseState } from '../actions/state';
import type { CaseState } from '../actions/types';
import type { ExecutorService } from '../execution/executor.service';
import { approverHint, evaluatePolicy } from '../policy/evaluate';
import { riskTierFromRules } from '../policy/risk';
import { isCaptured } from '../reconciliation/facts';
import type { ValidatorService } from '../validation/validator.service';
import { auditFrom, type AuditService, type WriteContext } from './audit.service';
import { CLOSED_CASE_STATUSES, type CaseService } from './case.service';
import type { ReconciliationService } from './reconciliation.service';
import type { ResolutionQueryService } from './resolution-query.service';

/** "Refund customer ₹78,000.00" / "Hold payment · Escalate". */
export function actionsSummary(actions: readonly CatalogAction[]): string {
  return actions
    .map((a) => (a.type === 'INITIATE_REFUND' ? `${ACTION_META[a.type].label} ${formatMoney(a.params.amountMinor)}` : ACTION_META[a.type].label))
    .join(' · ');
}

export function userActor(user: Pick<SessionUser, 'id' | 'name'>): ActorRef {
  return { type: 'USER', id: user.id, name: user.name };
}

export function userWriteContext(user: Pick<SessionUser, 'id' | 'name'>): WriteContext {
  return { actor: { actorType: 'USER', actorId: user.id, actorName: user.name } };
}

/** The agent's actor identity for a run, used on its resolution, audit rows and case updates. */
export function agentActor(runId: string): ActorRef {
  return { type: 'AGENT', id: runId, name: 'PayOps Agent' };
}

export function agentWriteContext(caseId: string, runId: string): WriteContext {
  return { actor: { actorType: 'AGENT', actorId: runId, actorName: 'PayOps Agent' }, caseId, runId };
}

const VALIDATOR_CTX: WriteContext = { actor: { actorType: 'SYSTEM', actorId: 'validator', actorName: 'Validator' } };

export class ResolutionService {
  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
    private readonly gateway: PaymentGatewayPort,
    private readonly audit: AuditService,
    private readonly events: EventPublisherPort,
    private readonly cases: CaseService,
    private readonly reconciliation: ReconciliationService,
    private readonly queries: ResolutionQueryService,
    private readonly executor: ExecutorService,
    private readonly validator: ValidatorService,
  ) {}

  private approvalItem: ((approvalId: string) => Promise<ApprovalItem>) | null = null;

  /** Wired by the composition root: approval.requested carries a full ApprovalItem (shared contract). */
  useApprovalItems(load: (approvalId: string) => Promise<ApprovalItem>): void {
    this.approvalItem = load;
  }

  private async attemptsSoFar(db: Pick<Db, 'select'>, caseId: string): Promise<number> {
    const [row] = await db.select({ n: count() }).from(resolutions).where(eq(resolutions.caseId, caseId));
    return row?.n ?? 0;
  }

  /** Policy inputs for a person's proposal. Phase 3 adds an agent variant with confidence and grounding. */
  private evaluate(state: CaseState, actions: readonly CatalogAction[], attempt: number) {
    const preconditionFailures = checkPreconditions(actions, state);
    const decision = evaluatePolicy({
      proposer: 'USER',
      actions,
      riskTier: riskTierFromRules(state.order),
      attempt,
      diagnosisConfidence: null,
      groundingViolations: 0,
      preconditionFailures: preconditionFailures.length,
      gatewayCaptureVerified: state.order ? isCaptured(state.order.primaryGw) : false,
    });
    return { decision, preconditionFailures };
  }

  async preview(caseId: string, actions: readonly CatalogAction[], _viewer: SessionUser): Promise<PolicyPreview> {
    const state = await loadCaseState(this.db, this.gateway, caseId, this.clock.now());
    const attempt = (await this.attemptsSoFar(this.db, caseId)) + 1;
    const { decision, preconditionFailures } = this.evaluate(state, actions, attempt);
    return { decision, preconditionFailures, approverHint: approverHint(decision.tier), attempt };
  }

  /** Policy inputs for an agent's proposal (docs/03-agent-system.md §11). */
  private evaluateAgent(
    state: CaseState,
    actions: readonly CatalogAction[],
    attempt: number,
    diagnosisConfidence: number,
    groundingViolations: number,
  ) {
    const preconditionFailures = checkPreconditions(actions, state);
    const decision = evaluatePolicy({
      proposer: 'AGENT',
      actions,
      riskTier: riskTierFromRules(state.order),
      attempt,
      diagnosisConfidence,
      groundingViolations,
      preconditionFailures: preconditionFailures.length,
      gatewayCaptureVerified: state.order ? isCaptured(state.order.primaryGw) : false,
    });
    return { decision, preconditionFailures };
  }

  /**
   * An agent run proposes a resolution (docs/03-agent-system.md §5, node `policyGate`). Same
   * policy engine, same resolution/approval tables as a person's proposal; the caller (the graph's
   * `policyGate` node) reads `decision.tier` off the result to route to `interrupt`, `execute` or
   * an escalation, and never lets a BLOCKED proposal execute.
   */
  async proposeFromAgent(
    caseId: string,
    runId: string,
    proposal: { actions: readonly CatalogAction[]; rationale: string },
    agentInputs: { diagnosisConfidence: number; groundingViolations: number },
  ): Promise<{ resolution: ResolutionRow; approvalId: string | null; preconditionFailures: PreconditionFailure[] }> {
    const write = agentWriteContext(caseId, runId);
    const state = await loadCaseState(this.db, this.gateway, caseId, this.clock.now());

    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(cases).where(eq(cases.id, caseId)).for('update').limit(1);
      if (!row) throw notFound('Case', caseId);
      if (CLOSED_CASE_STATUSES.includes(row.status)) throw new AppError('CONFLICT', `Case ${row.displayId} is ${row.status}`);
      const previous = await this.queries.rowsForCase(caseId, tx);
      const attempt = previous.length + 1;
      const { decision, preconditionFailures } = this.evaluateAgent(
        state,
        proposal.actions,
        attempt,
        agentInputs.diagnosisConfidence,
        agentInputs.groundingViolations,
      );
      const status: ResolutionStatus =
        decision.tier === 'BLOCKED' ? 'BLOCKED' : decision.tier === 'AUTO' ? 'EXECUTING' : 'AWAITING_APPROVAL';
      const now = this.clock.now();
      const [resolution] = await tx
        .insert(resolutions)
        .values({
          id: newId('resolution'),
          caseId,
          runId,
          attempt,
          actions: proposal.actions as CatalogAction[],
          rationale: proposal.rationale,
          proposedBy: agentActor(runId),
          policy: decision,
          status,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!resolution) throw new Error('resolution insert returned no row');
      await this.audit.record(
        auditFrom(write, {
          action: 'resolution.proposed',
          entityType: 'resolution',
          entityId: resolution.id,
          summary: `Agent run ${runId} proposed attempt ${attempt} for ${row.displayId}: ${actionsSummary(proposal.actions as CatalogAction[])}. Policy ${decision.tier} (${decision.reasons.map((r) => r.ruleId).join(', ') || 'no rule'})`,
          after: { actions: proposal.actions, policy: decision, preconditionFailures },
        }),
        tx,
      );

      let approvalId: string | null = null;
      if (decision.tier === 'OPS' || decision.tier === 'MANAGER') {
        approvalId = newId('approval');
        await tx.insert(approvals).values({
          id: approvalId,
          resolutionId: resolution.id,
          caseId,
          tier: decision.tier,
          status: 'PENDING',
          requestedBy: agentActor(runId),
          requestedAt: now,
        });
        await this.audit.record(
          auditFrom(write, {
            action: 'approval.requested',
            entityType: 'approval',
            entityId: approvalId,
            summary: `Agent run ${runId} needs ${decision.tier === 'MANAGER' ? 'a manager' : 'an OPS user'} to approve ${row.displayId}: ${actionsSummary(proposal.actions as CatalogAction[])}`,
          }),
          tx,
        );
        await this.cases.setStatus(tx, caseId, 'AWAITING_APPROVAL', `${row.displayId} is waiting for ${decision.tier} approval`, write);
      } else if (decision.tier === 'AUTO') {
        await this.cases.setStatus(tx, caseId, 'EXECUTING', `${row.displayId} is executing an AUTO-tier resolution`, write);
      } else {
        await this.cases.setStatus(tx, caseId, 'ESCALATED', `${row.displayId}: agent proposal blocked by policy, escalated to a person`, write);
      }
      return { resolution, approvalId, preconditionFailures };
    });

    await this.publish(created.resolution.id, caseId);
    if (created.approvalId && this.approvalItem) {
      const item = await this.approvalItem(created.approvalId);
      this.events.publish(ROOMS.ops, OPS_EVENTS.approvalRequested, item);
      this.events.publish(ROOMS.case(caseId), OPS_EVENTS.approvalRequested, item);
    }
    return created;
  }

  /**
   * A person proposes a resolution. BLOCKED is stored and rejected with 422; AUTO executes and
   * validates immediately; OPS/MANAGER waits for someone else's approval.
   */
  async propose(caseId: string, body: ProposeActionsBody, viewer: SessionUser): Promise<ResolutionItem> {
    const input = ProposeActionsBody.parse(body);
    if (!roleAtLeast(viewer.role, 'OPS')) throw new AppError('FORBIDDEN', 'Only OPS users and above can propose resolutions');
    const write = { ...userWriteContext(viewer), caseId };
    // Fresh state is read before the transaction: gateway reads use their own connection.
    const state = await loadCaseState(this.db, this.gateway, caseId, this.clock.now());

    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(cases).where(eq(cases.id, caseId)).for('update').limit(1);
      if (!row) throw notFound('Case', caseId);
      if (CLOSED_CASE_STATUSES.includes(row.status)) throw new AppError('CONFLICT', `Case ${row.displayId} is ${row.status}`);
      if (await this.queries.pendingApproval(caseId, tx)) {
        throw new AppError('CONFLICT', `Case ${row.displayId} already has a resolution waiting for approval`);
      }
      const previous = await this.queries.rowsForCase(caseId, tx);
      if (previous.some((r) => r.status === 'EXECUTING')) throw new AppError('CONFLICT', `A resolution for ${row.displayId} is executing`);

      const attempt = previous.length + 1;
      const { decision, preconditionFailures } = this.evaluate(state, input.actions, attempt);
      const status: ResolutionStatus =
        decision.tier === 'BLOCKED' ? 'BLOCKED' : decision.tier === 'AUTO' ? 'EXECUTING' : 'AWAITING_APPROVAL';
      const now = this.clock.now();
      const [resolution] = await tx
        .insert(resolutions)
        .values({
          id: newId('resolution'),
          caseId,
          runId: null,
          attempt,
          actions: input.actions,
          rationale: input.rationale,
          proposedBy: userActor(viewer),
          policy: decision,
          status,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!resolution) throw new Error('resolution insert returned no row');
      await this.audit.record(
        auditFrom(write, {
          action: 'resolution.proposed',
          entityType: 'resolution',
          entityId: resolution.id,
          summary: `${viewer.name} proposed attempt ${attempt} for ${row.displayId}: ${actionsSummary(input.actions)}. Policy ${decision.tier} (${decision.reasons.map((r) => r.ruleId).join(', ') || 'no rule'})`,
          after: { actions: input.actions, policy: decision, preconditionFailures },
        }),
        tx,
      );

      let approvalId: string | null = null;
      if (decision.tier === 'OPS' || decision.tier === 'MANAGER') {
        approvalId = newId('approval');
        await tx.insert(approvals).values({
          id: approvalId,
          resolutionId: resolution.id,
          caseId,
          tier: decision.tier,
          status: 'PENDING',
          requestedBy: userActor(viewer),
          requestedAt: now,
        });
        await this.audit.record(
          auditFrom(write, {
            action: 'approval.requested',
            entityType: 'approval',
            entityId: approvalId,
            summary: `Approval requested from ${decision.tier === 'MANAGER' ? 'a manager' : 'another OPS user'} for ${row.displayId}: ${actionsSummary(input.actions)}`,
          }),
          tx,
        );
        await this.cases.setStatus(tx, caseId, 'AWAITING_APPROVAL', `${row.displayId} is waiting for ${decision.tier} approval`, write);
      } else if (decision.tier === 'AUTO') {
        await this.cases.setStatus(tx, caseId, 'EXECUTING', `${row.displayId} is executing an AUTO-tier resolution`, write);
      }
      return { resolution, approvalId, preconditionFailures };
    });

    const { resolution } = created;
    if (resolution.status === 'BLOCKED') {
      await this.publish(resolution.id, caseId);
      throw new AppError('VALIDATION_FAILED', 'Policy blocked this proposal', {
        resolutionId: resolution.id,
        policy: resolution.policy,
        preconditionFailures: created.preconditionFailures,
      });
    }
    if (created.approvalId) {
      await this.publish(resolution.id, caseId);
      if (this.approvalItem) {
        const item = await this.approvalItem(created.approvalId);
        this.events.publish(ROOMS.ops, OPS_EVENTS.approvalRequested, item);
        this.events.publish(ROOMS.case(caseId), OPS_EVENTS.approvalRequested, item);
      }
      return this.queries.item(resolution.id);
    }
    return this.finish(resolution.id, write);
  }

  /**
   * Execute → validate → close. Called for AUTO proposals and after an approval.
   * PASS resolves the case (or leaves it ESCALATED when the resolution escalated); PARTIAL, FAIL
   * and execution failures send it back to OPEN with the outcome visible on the resolution.
   */
  async finish(resolutionId: string, write: WriteContext, opts: { onFailure?: 'OPEN' | 'ESCALATE' } = {}): Promise<ResolutionItem> {
    const resolution = await this.queries.row(resolutionId);
    const ctx: WriteContext = { ...write, caseId: resolution.caseId, runId: resolution.runId };
    const onFailureStatus: 'OPEN' | 'ESCALATED' = opts.onFailure === 'ESCALATE' ? 'ESCALATED' : 'OPEN';
    const execution = await this.executor.execute(resolutionId, ctx);

    if (!execution.ok) {
      const failed = execution.steps.find((s) => s.status === 'FAILED');
      const reopened = onFailureStatus === 'ESCALATED' ? 'escalated to a person' : 'reopened';
      await this.close(resolution, 'EXECUTION_FAILED', onFailureStatus, `Execution failed at step ${(failed?.index ?? 0) + 1}: ${failed?.error?.message ?? 'unknown error'}. Case ${reopened}`, ctx, null);
    } else {
      const validation = await this.validator.validate(resolutionId, VALIDATOR_CTX);
      const escalates = resolution.actions.some((a) => a.type === 'ESCALATE_TO_HUMAN');
      const summary = `${actionsSummary(resolution.actions)}. Validator ${validation.verdict} on attempt ${resolution.attempt}`;
      if (validation.verdict === 'PASS') {
        await this.close(resolution, 'VALIDATED', escalates ? 'ESCALATED' : 'RESOLVED', summary, ctx, escalates ? null : {
          by: resolution.proposedBy.type === 'AGENT' ? 'AGENT' : 'USER',
          summary,
          runId: resolution.runId,
        });
      } else {
        const reopened = onFailureStatus === 'ESCALATED' ? 'escalated to a person' : 'reopened';
        await this.close(resolution, 'VALIDATED', onFailureStatus, `${summary}. Case ${reopened}`, ctx, null);
      }
    }

    await this.refreshDetection(resolution.caseId);
    await this.publish(resolutionId, resolution.caseId);
    return this.queries.item(resolutionId);
  }

  private async close(
    resolution: ResolutionRow,
    status: ResolutionStatus,
    caseStatus: 'RESOLVED' | 'ESCALATED' | 'OPEN',
    summary: string,
    ctx: WriteContext,
    caseResolution: { by: 'USER' | 'AGENT'; summary: string; runId: string | null } | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(resolutions).set({ status, updatedAt: this.clock.now() }).where(eq(resolutions.id, resolution.id));
      const [row] = await tx.select({ status: cases.status, displayId: cases.displayId }).from(cases).where(eq(cases.id, resolution.caseId)).limit(1);
      // The ESCALATE action may already have moved the case; setStatus is a no-op audit-wise then.
      await this.cases.setStatus(tx, resolution.caseId, caseStatus, `${row?.displayId ?? resolution.caseId}: ${summary}`, ctx, caseStatus === 'RESOLVED' ? { resolution: caseResolution } : {});
    });
  }

  /** Re-run detection for the case's entities so payment flags and cases reflect the fix. */
  private async refreshDetection(caseId: string): Promise<void> {
    const [row] = await this.db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    if (!row) return;
    const refs: CaseRow['entityRefs'] = row.entityRefs;
    if (refs.orderId) await this.reconciliation.checkOrders([refs.orderId]);
    if (row.type === 'SETTLEMENT_MISMATCH' && refs.batchId) await this.reconciliation.checkBatches([refs.batchId]);
    await this.cases.refreshStoredMatrix(caseId);
  }

  private async publish(resolutionId: string, caseId: string): Promise<void> {
    const [item, caseItems] = await Promise.all([this.queries.item(resolutionId), this.cases.listItems([caseId])]);
    this.events.publish(ROOMS.ops, OPS_EVENTS.resolutionUpdated, item);
    this.events.publish(ROOMS.case(caseId), OPS_EVENTS.resolutionUpdated, item);
    const caseItem = caseItems[0];
    if (caseItem) {
      this.events.publish(ROOMS.ops, OPS_EVENTS.caseUpdated, caseItem);
      this.events.publish(ROOMS.case(caseId), OPS_EVENTS.caseUpdated, caseItem);
    }
  }
}
