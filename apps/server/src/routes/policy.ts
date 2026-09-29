import { Router } from 'express';
import { APPROVER_ROLE, POLICY_RULES, POLICY_THRESHOLDS, POLICY_VERSION, formatMoney, type PolicyDocument } from '@payops/shared';
import { requirePermission } from '../auth/middleware';

export function policyDocument(): PolicyDocument {
  const t = POLICY_THRESHOLDS;
  return {
    version: POLICY_VERSION,
    rules: POLICY_RULES,
    thresholds: [
      { label: 'Refunds approved automatically up to', value: formatMoney(t.autoRefundMaxMinor) },
      { label: 'Refunds an OPS user can approve up to', value: formatMoney(t.opsRefundMaxMinor) },
      { label: 'Agent confidence for automatic refunds', value: t.autoRefundMinConfidence.toFixed(2) },
      { label: 'Agent confidence for automatic state corrections', value: t.autoCorrectionMinConfidence.toFixed(2) },
      { label: 'Agent confidence below which a person reviews', value: t.lowConfidence.toFixed(2) },
    ],
    approverRoles: [
      { tier: 'AUTO', approver: 'No approval needed' },
      { tier: 'OPS', approver: `Another ${APPROVER_ROLE.OPS} user, a manager or an admin` },
      { tier: 'MANAGER', approver: 'A manager or an admin' },
      { tier: 'BLOCKED', approver: 'Cannot be approved' },
    ],
  };
}

export function policyRoutes(): Router {
  const router = Router();
  router.get('/', requirePermission('policy.view'), (_req, res) => {
    res.json(policyDocument());
  });
  return router;
}
