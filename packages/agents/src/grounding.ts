/**
 * Pure J4 grounding logic (docs/03-agent-system.md §4 "J4 · Grounding check", §7 "Evidence
 * model"), kept separate from the `groundCheck` graph node (nodes.ts) so the drop rule, the
 * sufficiency/round-cap routing decision and the gap computation are unit-testable without a
 * `DecisionPort` or a graph -- the same split task 3 made for `plan`/`choosePlanSpecialists`
 * (planning.ts).
 *
 * Two passes, run in this order, matching §7's "Structural grounding (code, before J4)":
 *   1. `applyStructuralGrounding` -- every FindingCode's fact predicate (grounding/predicates.ts)
 *      must hold on the finding's own cited evidence. Failing = a structural `GroundingViolation`,
 *      finding dropped before Jev ever sees it.
 *   2. `applyGroundingRules` -- folds in J4's semantic answers (or `null` on the adapter-contract
 *      fallback) and decides: which findings survive, whether the case is sufficiently
 *      investigated, and -- if not, and the round budget allows it -- which specialists own the
 *      resulting gaps.
 */
import { choice, noul, type JsonValue } from '@payops/core';
import { AGENT_NAMES, type AgentName, type EvidenceGap, type EvidenceItem, type Finding, type GroundingViolation } from '@payops/shared';
import { FINDING_PREDICATES } from './grounding/predicates';

/** J5 uses `MAX_ATTEMPTS = 2` for replan; J4 uses the same-shaped cap on investigation rounds
 * (docs/03 §4 "J4": "investigationRounds < 2"). `plan` (nodes.ts) increments `investigationRound`
 * every time it runs, including the very first (full-path) call, so this is a *count of `plan`
 * calls allowed*, not "extra rounds after the first" -- one extra targeted round total. */
export const MAX_INVESTIGATION_ROUNDS = 2;

/** Below this, J4's `sufficient` Noul or a `contradicted` Choice's confidence are treated as "no"
 * (docs/03 §4's literal thresholds: "sufficient < 0.5", "contradicted with confidence >= 0.5"). */
const SUFFICIENCY_THRESHOLD = 0.5;
const SEMANTIC_DROP_THRESHOLD = 0.5;

// ── Pass 1: structural (code, before J4) ────────────────────────────────────────────────────

export interface StructuralGroundingResult {
  violations: GroundingViolation[];
  /** Findings whose evidenceIds all exist and whose FindingCode predicate held. */
  sound: Finding[];
}

/**
 * Defense-in-depth beyond the "ids exist, non-empty" check the specialist nodes already run
 * before a finding ever enters `state.findings` (nodes.ts, `buildSpecialistNode`/`riskAgent`):
 * this also enforces the fuller §7 rule ("every FindingCode has a fact predicate that must hold
 * on the cited evidence"), and re-checks id existence too, since `groundCheck` runs after the
 * fan-out/`join` merge rather than trusting each specialist got it right.
 */
export function applyStructuralGrounding(findings: readonly Finding[], evidenceById: ReadonlyMap<string, EvidenceItem>): StructuralGroundingResult {
  const violations: GroundingViolation[] = [];
  const sound: Finding[] = [];
  for (const f of findings) {
    const cited: EvidenceItem[] = [];
    let allExist = true;
    for (const id of f.evidenceIds) {
      const item = evidenceById.get(id);
      if (!item) { allExist = false; break; }
      cited.push(item);
    }
    if (!allExist) {
      violations.push({ findingId: f.id, reason: 'cites an evidence id that does not exist' });
      continue;
    }
    if (!FINDING_PREDICATES[f.code](cited)) {
      violations.push({ findingId: f.id, reason: `cited evidence does not satisfy the ${f.code} predicate` });
      continue;
    }
    sound.push(f);
  }
  return { violations, sound };
}

// ── Pass 2: semantic (J4, Jev) + the code rules that act on it ─────────────────────────────

/** Labels for J4's per-claim `support` Choice (docs/03 §4). */
export const SUPPORT_CRITERIA = {
  supported: 'The cited evidence clearly supports this claim.',
  contradicted: 'The cited evidence contradicts or is inconsistent with this claim.',
  not_enough_evidence: 'The cited evidence does not go far enough to say either way.',
} as const;

export type SupportLabel = keyof typeof SUPPORT_CRITERIA;

/** One finding's `support` answer, already unwrapped from the Jev response shape so
 * `applyGroundingRules` does not need to know about `ChoiceResponse`/`NoulResponse`. */
export interface SupportAnswer {
  findingId: string;
  choice: SupportLabel;
  confidence: number;
}

/** `support_<findingId>` -- the batched Choice question key for one finding's claim. */
export function supportKey(findingId: string): string {
  return `support_${findingId}`;
}

export type GroundingQuestions = Record<string, ReturnType<typeof choice<typeof SUPPORT_CRITERIA>> | ReturnType<typeof noul>>;

/**
 * Builds the single batched J4 call (docs/03 §4: "one Choice per claim, batched ... plus one
 * Noul: sufficient"): `state` is `{ claims: [{ id, claim, cited_evidence }] }` (facts only, never
 * raw prompts -- same "compact, typed state" shape J1/J2/J3/J6 already use, docs/03 §4), and
 * `questions` has one `support_<id>` Choice per structurally-sound finding plus `sufficient`.
 */
export interface GroundingClaimState {
  id: string;
  claim: string;
  cited_evidence: Record<string, string | number | boolean>[];
}

export function buildGroundingRequest(
  findings: readonly Finding[],
  evidenceById: ReadonlyMap<string, EvidenceItem>,
): { state: JsonValue; questions: GroundingQuestions } {
  const claims: GroundingClaimState[] = findings.map((f) => ({
    id: f.id,
    claim: f.statement,
    cited_evidence: f.evidenceIds.map((id) => evidenceById.get(id)?.facts ?? {}),
  }));
  const questions: GroundingQuestions = {};
  for (const f of findings) {
    questions[supportKey(f.id)] = choice(`Is the claim "${f.id}" supported by its cited evidence?`, SUPPORT_CRITERIA);
  }
  questions.sufficient = noul('The evidence gathered so far is enough to determine why the systems disagree in this case.');
  // `GroundingClaimState`/its `cited_evidence` facts are plain string/number/boolean-valued
  // objects and arrays, i.e. already JSON-compatible; the cast is only needed because
  // `JsonValue`'s recursive index signature does not structurally match a named interface.
  return { state: { claims } as unknown as JsonValue, questions };
}

export interface GroundingRulesInput {
  /** Every finding currently in state (used to compute survivors: append-only §6, so nothing is
   * ever physically removed from `state.findings` -- `resolve` filters by `violations` instead,
   * see docs/DECISIONS.md D041). */
  findings: readonly Finding[];
  structuralViolations: readonly GroundingViolation[];
  /** `null` on the J4 adapter-contract fallback (Jev error/timeout) -- semantic checking and the
   * `sufficient` read are both skipped, never a guessed answer. */
  semanticAnswers: readonly SupportAnswer[] | null;
  sufficientNoul: number | null;
  agentsVisited: readonly string[];
  investigationRound: number;
}

export interface GroundingRulesResult {
  violations: GroundingViolation[];
  survivingFindings: Finding[];
  sufficient: boolean;
  needsHumanReview: boolean;
  gaps: EvidenceGap[];
}

/**
 * One `agent` names a gap once per re-round, even if it lost more than one finding, and only
 * for agents that actually ran (`agentsVisited`) -- an agent `plan` never selected is not
 * "missing evidence", it was never asked (docs/03 §4 "one extra targeted round (only the
 * specialists owning the gaps)").
 */
export function computeGaps(agentsVisited: readonly string[], survivingFindings: readonly Finding[]): EvidenceGap[] {
  const visited = new Set(agentsVisited.filter((a): a is AgentName => (AGENT_NAMES as readonly string[]).includes(a)));
  const withSurvivingFindings = new Set(survivingFindings.map((f) => f.agent));
  return AGENT_NAMES.filter((agent) => visited.has(agent) && !withSurvivingFindings.has(agent)).map((agent) => ({
    agent,
    reason: `${agent} ran but has no findings that survived grounding`,
  }));
}

/**
 * The code rules from docs/03 §4 "J4", exactly:
 * - any `contradicted` at confidence >= 0.5 -> drop that finding, record a `GroundingViolation`.
 * - `sufficient < 0.5` and `investigationRound < 2` -> gaps for the agents that need to re-run;
 *   otherwise (sufficient, or the round cap is already spent) no gaps, and `groundCheck` routes
 *   straight to `resolve`.
 * - Jev fallback (adapter contract): `semanticAnswers === null` means only the structural pass
 *   ran; `needsHumanReview` is set, `sufficient` defaults to `true` and no gaps are produced --
 *   "the fallback never adds an extra round on its own" is enforced by construction here, not by
 *   the caller remembering not to.
 */
export function applyGroundingRules(input: GroundingRulesInput): GroundingRulesResult {
  const violations = [...input.structuralViolations];
  if (input.semanticAnswers) {
    for (const answer of input.semanticAnswers) {
      if (answer.choice === 'contradicted' && answer.confidence >= SEMANTIC_DROP_THRESHOLD) {
        violations.push({ findingId: answer.findingId, reason: 'Jev J4 marked this claim contradicted by its cited evidence' });
      }
    }
  }

  const droppedIds = new Set(violations.map((v) => v.findingId));
  const survivingFindings = input.findings.filter((f) => !droppedIds.has(f.id));

  const needsHumanReview = input.semanticAnswers === null;
  const sufficient = needsHumanReview ? true : (input.sufficientNoul ?? 1) >= SUFFICIENCY_THRESHOLD;

  const canTakeExtraRound = !needsHumanReview && !sufficient && input.investigationRound < MAX_INVESTIGATION_ROUNDS;
  const gaps = canTakeExtraRound ? computeGaps(input.agentsVisited, survivingFindings) : [];

  return { violations, survivingFindings, sufficient, needsHumanReview, gaps };
}

/** `resolve` (nodes.ts) reads `state.findings` + `state.grounding` and must never build context
 * from, or let the LLM cite, a finding that grounding dropped -- since `state.findings` is
 * append-only (state.ts), the drop is applied here at the point of use, not by removing the
 * item from state. */
export function survivingFindings(findings: readonly Finding[], violations: readonly GroundingViolation[] | undefined): Finding[] {
  if (!violations || violations.length === 0) return [...findings];
  const droppedIds = new Set(violations.map((v) => v.findingId));
  return findings.filter((f) => !droppedIds.has(f.id));
}
