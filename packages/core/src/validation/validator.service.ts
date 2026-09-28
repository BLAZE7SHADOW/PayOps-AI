/**
 * The validator never trusts the executor or stored state: it loads a fresh case snapshot and
 * checks (1) each action's postconditions and (2) global invariants for the case entities:
 *   - the state matrix shows no system disagreeing with the gateway, except SETTLEMENT on a
 *     settlement case whose difference is covered by an open dispute;
 *   - detection, re-run now, has no hit for the case's fingerprint.
 * Verdict: FAIL if any postcondition fails, PARTIAL if only an invariant fails, else PASS.
 */
import { SYSTEMS, newId, type ValidationCheck, type ValidationVerdict } from '@payops/shared';
import type { Db } from '../db/client';
import type { ValidationResultRow } from '../db/rows';
import { validationResults } from '../db/schema';
import type { ClockPort } from '../ports/clock';
import type { PaymentGatewayPort } from '../ports/gateway';
import { postconditionsOf } from '../actions/registry';
import { loadCaseState } from '../actions/state';
import type { CaseState } from '../actions/types';
import { fingerprintOf } from '../reconciliation/candidates';
import { buildMatrix } from '../reconciliation/matrix';
import { runOrderRules } from '../reconciliation/rules';
import { auditFrom, type AuditService, type WriteContext } from '../services/audit.service';
import type { ResolutionQueryService } from '../services/resolution-query.service';

const invariant = (id: string, fields: Omit<ValidationCheck, 'id' | 'kind' | 'actionIndex'>): ValidationCheck => ({
  id: `inv.${id}`,
  kind: 'INVARIANT',
  actionIndex: null,
  ...fields,
});

/** Global invariants for a case, from fresh state. Exported for tests. */
export function caseInvariants(state: CaseState): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const isSettlementCase = state.case.type === 'SETTLEMENT_MISMATCH';
  const disputed = isSettlementCase && state.batch?.check.disputeId != null;

  if (state.order) {
    const matrix = buildMatrix(state.order);
    const allowed = new Set(disputed ? ['SETTLEMENT'] : []);
    const wrong = matrix.mismatched.filter((k) => !allowed.has(k));
    if (wrong.length === 0) {
      checks.push(
        invariant('matrix', {
          subject: 'state matrix',
          description: 'Every system agrees with the gateway',
          expected: 'no mismatched systems',
          actual: disputed && matrix.mismatched.includes('SETTLEMENT') ? 'only SETTLEMENT differs, covered by an open dispute' : 'no mismatched systems',
          pass: true,
        }),
      );
    }
    for (const k of SYSTEMS.filter((s) => wrong.includes(s))) {
      const cell = matrix.cells[k];
      checks.push(
        invariant(`matrix.${k}`, {
          subject: `${k.toLowerCase()} cell`,
          description: `${k} agrees with the gateway`,
          expected: 'agrees with gateway',
          actual: [cell.status, cell.detail].filter(Boolean).join(': ') || 'mismatch',
          pass: false,
        }),
      );
    }
  }

  const hits = [
    ...(state.order ? runOrderRules(state.order) : []),
    ...(isSettlementCase && state.batch?.check.hit ? [state.batch.check.hit] : []),
  ].filter((h) => fingerprintOf(h) === state.case.fingerprint);
  checks.push(
    invariant('detection', {
      subject: 'detection rules',
      description: 'Re-running detection finds nothing for this case',
      expected: 'no rule fires',
      actual: hits.length ? hits.map((h) => `${h.ruleId}: ${h.reason}`).join(' ') : 'no rule fires',
      pass: hits.length === 0,
    }),
  );
  return checks;
}

export function verdictOf(checks: readonly ValidationCheck[]): ValidationVerdict {
  if (checks.some((c) => c.kind === 'POSTCONDITION' && !c.pass)) return 'FAIL';
  if (checks.some((c) => !c.pass)) return 'PARTIAL';
  return 'PASS';
}

export class ValidatorService {
  constructor(
    private readonly db: Db,
    private readonly clock: ClockPort,
    private readonly gateway: PaymentGatewayPort,
    private readonly audit: AuditService,
    private readonly queries: ResolutionQueryService,
  ) {}

  async validate(resolutionId: string, write: WriteContext): Promise<ValidationResultRow> {
    const resolution = await this.queries.row(resolutionId, this.db);
    const state = await loadCaseState(this.db, this.gateway, resolution.caseId, this.clock.now());
    const checks = [...resolution.actions.flatMap((a, i) => postconditionsOf(a, state, i)), ...caseInvariants(state)];
    const verdict = verdictOf(checks);
    const failed = checks.filter((c) => !c.pass).length;
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(validationResults)
        .values({
          id: newId('validation'),
          resolutionId,
          caseId: resolution.caseId,
          attempt: resolution.attempt,
          verdict,
          checks,
          at: this.clock.now(),
        })
        .returning();
      if (!row) throw new Error('validation insert returned no row');
      await this.audit.record(
        auditFrom(
          { ...write, caseId: resolution.caseId, runId: resolution.runId },
          {
            action: 'resolution.validated',
            entityType: 'resolution',
            entityId: resolutionId,
            summary: `Validator ${verdict}: ${checks.length - failed} of ${checks.length} checks passed on attempt ${resolution.attempt}`,
            after: { verdict, failed: checks.filter((c) => !c.pass).map((c) => c.id) },
          },
        ),
        tx,
      );
      return row;
    });
  }
}
