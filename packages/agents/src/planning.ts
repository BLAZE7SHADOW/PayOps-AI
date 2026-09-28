/**
 * Pure J2 routing logic (docs/03-agent-system.md §4 "J2 · Investigation plan"), kept separate
 * from the `plan` graph node so it is unit-testable without a DecisionPort or a graph. `plan`
 * (nodes.ts) calls `choosePlanSpecialists` after asking Jev (or on the J2 fallback: run ALL).
 */
import { AGENT_NAMES, type AgentName, type AmountBand } from '@payops/shared';

export interface PlanRoutingInput {
  amountBand: AmountBand;
  /** Jev's confidence in `primary_hypothesis`. */
  primaryConfidence: number;
  /** Jev's `need_<agent>` Noul probabilities, one per specialist. */
  needScores: Record<AgentName, number>;
}

const NEED_THRESHOLD = 0.35;
const CONFIDENCE_FLOOR = 0.5;

/**
 * Payment is mandatory for every case: this is a payments-ops product, so every case traces back
 * to an underlying payment (docs/03 §4 "Payment is always run for payment cases"). Risk is
 * mandatory once the amount band reaches HIGH, regardless of what Jev says, since a large-value
 * case always deserves a fraud look even if Jev's `need_risk` came back low.
 */
function mandatorySpecialists(amountBand: AmountBand): AgentName[] {
  const mandatory: AgentName[] = ['payment'];
  if (amountBand === 'HIGH' || amountBand === 'CRITICAL') mandatory.push('risk');
  return mandatory;
}

export function choosePlanSpecialists(input: PlanRoutingInput): AgentName[] {
  // Safe default (docs/03 §4): a low-confidence hypothesis means Jev is unsure which trail
  // matters, so run every specialist rather than guess.
  if (input.primaryConfidence < CONFIDENCE_FLOOR) return [...AGENT_NAMES];

  const chosen = new Set<AgentName>(mandatorySpecialists(input.amountBand));
  for (const name of AGENT_NAMES) {
    if (input.needScores[name] >= NEED_THRESHOLD) chosen.add(name);
  }
  // Stable, deterministic order (payment, reconciliation, risk) regardless of Set insertion order.
  return AGENT_NAMES.filter((name) => chosen.has(name));
}
