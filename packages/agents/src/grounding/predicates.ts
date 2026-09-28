/**
 * Structural grounding predicates (docs/03-agent-system.md §7 "Evidence model"): "every
 * `FindingCode` has a fact predicate that must hold on the cited evidence ... failing predicate
 * = violation, finding dropped." One predicate per `FindingCode`, checked by `groundCheck`
 * (nodes.ts, via `grounding.ts`) against exactly the evidence a finding cites -- never the
 * whole evidence pool, since a finding is only as grounded as what it actually names.
 *
 * A predicate answers "does *some* combination of the cited items support this code", not "is
 * the claim true" -- truth (specifically, is the claim *contradicted*) is J4's job (Jev, semantic,
 * `grounding.ts`). This file only checks that the finding cited the *right kind* of evidence for
 * its code, using facts that a real `ToolDef.run` in `tools.ts` actually projects. See
 * docs/DECISIONS.md D041 for which codes have a loose or partial predicate and why (no tool
 * currently projects a fact strong enough for a tighter one), rather than inventing a fact that
 * does not exist in any tool's output.
 */
import type { EvidenceItem, FindingCode } from '@payops/shared';

type Predicate = (cited: readonly EvidenceItem[]) => boolean;

const bySystem = (cited: readonly EvidenceItem[], system: EvidenceItem['system']) => cited.filter((e) => e.system === system);
const bySource = (cited: readonly EvidenceItem[], source: string) => cited.filter((e) => e.source === source);
const numberFact = (e: EvidenceItem, key: string): number | null => (typeof e.facts[key] === 'number' ? (e.facts[key] as number) : null);
const stringFact = (e: EvidenceItem, key: string): string | null => (typeof e.facts[key] === 'string' ? (e.facts[key] as string) : null);
const boolFact = (e: EvidenceItem, key: string): boolean => e.facts[key] === true;

export const FINDING_PREDICATES: Record<FindingCode, Predicate> = {
  // getWebhookDeliveries (tools.ts) projects `lastHttpStatus` on every WEBHOOK item -- the doc's
  // own literal example ("WEBHOOK_HTTP_500 requires some cited item with system=WEBHOOK and
  // facts.httpStatus >= 500"), using this tool's actual field name.
  WEBHOOK_HTTP_500: (cited) => bySystem(cited, 'WEBHOOK').some((e) => (numberFact(e, 'lastHttpStatus') ?? 0) >= 500),

  // "Undelivered" is the webhook's own `finalStatus` (enums.ts `WEBHOOK_DELIVERY_STATUS`) never
  // reaching DELIVERED -- FAILED or still PENDING both count as "not delivered".
  WEBHOOK_UNDELIVERED: (cited) => bySystem(cited, 'WEBHOOK').some((e) => stringFact(e, 'finalStatus') !== 'DELIVERED'),

  // A divergence claim is a comparison between two systems, so the structural floor is: the
  // finding actually cited evidence from *both* sides of the comparison it claims to be making
  // (GATEWAY is the reference system, ORDER is our own record -- docs/03 §3). We cannot recompute
  // "diverged" itself in code without duplicating the reconciliation matrix's own state-comparison
  // logic (which uses a much richer status vocabulary than either tool's raw enum) -- that
  // recomputation is exactly the semantic judgement J4 makes, not a structural predicate.
  ORDER_STATE_DIVERGED: (cited) => bySystem(cited, 'GATEWAY').length > 0 && bySystem(cited, 'ORDER').length > 0,

  // A "missing" claim cites the trigger (something the gateway captured) and, structurally, must
  // not *also* cite a ledger credit that would contradict its own claim. Absence-of-evidence
  // beyond the cited set is not something a predicate over *cited* evidence can check (docs/03
  // §7 predicates run "on the cited evidence"), so this is deliberately the loose half of the
  // check -- the tight half (is there truly no ledger credit anywhere) is what J4's
  // `not_enough_evidence`/`contradicted` answers are for. D041.
  LEDGER_CREDIT_MISSING: (cited) =>
    (bySystem(cited, 'GATEWAY').some((e) => stringFact(e, 'status') === 'CAPTURED') ||
      bySystem(cited, 'ORDER').some((e) => stringFact(e, 'status') === 'PAID' || stringFact(e, 'status') === 'FULFILLED')) &&
    !bySystem(cited, 'LEDGER').some((e) => stringFact(e, 'direction') === 'CREDIT'),

  // getGatewayPayment (tools.ts) emits one evidence item per gateway payment row, entityRef'd by
  // that row's own id -- two distinct CAPTURED gateway payments cited for the same case is
  // literally what "duplicate capture" means at the evidence level.
  DUPLICATE_CAPTURE_DETECTED: (cited) => {
    const captured = bySystem(cited, 'GATEWAY').filter((e) => stringFact(e, 'status') === 'CAPTURED');
    return new Set(captured.map((e) => e.entityRef)).size >= 2;
  },

  // A mismatch claim must cite both sides of the comparison: our own refund record (getRefund)
  // and what the gateway reports (getRefundGatewayStatus), with different raw status strings.
  // The two tools use different enums (`RefundStatus` vs `GwRefundStatus`, enums.ts) that are not
  // directly comparable without the mapping `REFUND_STATUS_FROM_GATEWAY` owns
  // (refund.service.ts) -- reproducing that mapping here would duplicate domain logic that
  // already lives in core, so this predicate checks "both sides cited, and they disagree even on
  // the raw label", which is the structural floor; whether the disagreement is a *real* mismatch
  // once mapped is exactly what J4 is for.
  REFUND_STATUS_MISMATCH: (cited) => {
    const internal = bySource(cited, 'getRefund')[0];
    const gateway = bySource(cited, 'getRefundGatewayStatus')[0];
    if (!internal || !gateway) return false;
    return stringFact(internal, 'status') !== stringFact(gateway, 'status');
  },

  // Known gap (D041): no tool asserts "a refund should exist for this order" as a positive fact
  // -- the closest signal is an ORDER already marked CANCELLED with nothing in REFUND evidence
  // cited alongside it. This is a weak proxy (a cancelled order that was never captured also
  // matches), kept intentionally loose rather than inventing an `expectsRefund` fact no tool
  // projects; it still rejects the common corrupted-finding case (citing unrelated WEBHOOK/RISK
  // evidence for a refund claim).
  REFUND_MISSING: (cited) => bySystem(cited, 'ORDER').some((e) => stringFact(e, 'status') === 'CANCELLED') && bySystem(cited, 'REFUND').length === 0,

  // getRefund / getRefundGatewayStatus both use `status: 'FAILED'` in their own enum
  // (RefundStatus / GwRefundStatus, enums.ts) -- either side reporting FAILED is cause enough.
  REFUND_FAILED: (cited) => bySystem(cited, 'REFUND').some((e) => stringFact(e, 'status') === 'FAILED'),

  // getFeeBreakdown (tools.ts) already computes `matched`/`diffMinor` in code (D039) -- the exact
  // "numbers pre-digested" pattern the doc asks for, so the predicate just reads it back.
  SETTLEMENT_FEE_DIFF: (cited) => bySystem(cited, 'SETTLEMENT').some((e) => boolFact(e, 'matched') === false || (numberFact(e, 'diffMinor') ?? 0) !== 0),

  // Known gap (D041): `getSettlementLines` returns every line in the batch, not "this payment's
  // line, or nothing if absent" -- there is no tool fact that means "this specific line is
  // missing". The loose proxy: the finding cites the batch-level `getFeeBreakdown` evidence
  // (so it is at least talking about a real settlement mismatch) but never cites a
  // `getSettlementLines` item, i.e. it never pointed at a specific line to back up "missing".
  SETTLEMENT_LINE_MISSING: (cited) => bySource(cited, 'getFeeBreakdown').length > 0 && bySource(cited, 'getSettlementLines').length === 0,

  // Every risk tool projects `system: 'RISK'` (tools.ts) -- citing any risk evidence at all is
  // the structural floor for a risk-signal claim; which signal and how strong is Risk's own J3
  // scoring (docs/03 §4 "J3"), not a grounding predicate.
  RISK_SIGNAL: (cited) => bySystem(cited, 'RISK').length > 0,

  // `OTHER` is the deliberate catch-all used by the fast-path narrative template (templates.ts)
  // and any specialist finding that does not fit a more specific code -- it has no fixed evidence
  // shape to check, so (per the doc: a finding must simply cite *some* existing evidence, which
  // the "ids exist" check already enforces upstream) it always passes here.
  OTHER: () => true,
};
