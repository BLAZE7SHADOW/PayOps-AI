/**
 * The one role and permission table. Routes, services and the UI all read it, and
 * docs/02-architecture.md §7 is checked against it in a test, so the code and the docs cannot drift.
 *
 * Roles are ranked VIEWER < OPS < MANAGER < ADMIN. A permission names the lowest role that has it;
 * higher roles have it too. Some permissions carry an extra rule that code enforces on top of the
 * role (four-eyes, tier, ownership). Those are written in `extra` so a reader sees them in one place.
 */
import { roleAtLeast, type Role } from './enums';

export interface PermissionDef {
  /** Lowest role that has this permission. */
  role: Role;
  /** Plain description for the docs table. */
  what: string;
  /** Rule enforced in code beyond the role, or null. */
  extra: string | null;
}

export const PERMISSIONS = {
  // Reading
  'overview.view': { role: 'VIEWER', what: 'See the Overview metrics', extra: null },
  'payment.view': { role: 'VIEWER', what: 'List payments and open a payment', extra: null },
  'case.view': { role: 'VIEWER', what: 'List cases, open a case, its notes and source records', extra: null },
  'run.view': { role: 'VIEWER', what: 'See agent runs, steps and feedback', extra: null },
  'approval.view': { role: 'VIEWER', what: 'See the approval queue and one approval', extra: null },
  'audit.view': { role: 'VIEWER', what: 'Read the audit log', extra: null },
  'audit.verify': { role: 'MANAGER', what: 'Check the audit log for tampering and export it as CSV', extra: null },
  'policy.view': { role: 'VIEWER', what: 'Read the policy rules', extra: null },
  'webhook.view': { role: 'VIEWER', what: 'Read the webhook event log', extra: null },
  'agent.view': { role: 'VIEWER', what: 'See agent controls', extra: null },
  'handoff.view': { role: 'VIEWER', what: 'Read the shift handoff summary', extra: null },
  'view.manage': { role: 'VIEWER', what: 'Save and delete your own saved views', extra: 'Own views only' },
  'account.security': { role: 'VIEWER', what: 'Manage your own MFA and signed-in browsers', extra: 'Own account only' },
  // Working cases
  'case.assign': { role: 'OPS', what: 'Take a case or hand it back', extra: 'The assignee must be OPS or above' },
  'case.note': { role: 'OPS', what: 'Write a case note', extra: null },
  'run.start': { role: 'OPS', what: 'Start an agent investigation on a case', extra: null },
  'run.feedback': { role: 'OPS', what: 'Mark a diagnosis right or wrong', extra: null },
  'resolution.propose': { role: 'OPS', what: 'Preview and propose a resolution', extra: 'Policy decides the tier' },
  'resolution.undo': { role: 'OPS', what: 'Propose an undo of a ledger post', extra: 'Goes through the normal approval' },
  'webhook.replay': { role: 'OPS', what: 'Replay a webhook event', extra: null },
  'approval.decide': {
    role: 'OPS',
    what: 'Approve or reject a resolution',
    extra: 'MANAGER-tier approvals need MANAGER or ADMIN. Four-eyes: never your own proposal',
  },
  'approval.bulk': { role: 'OPS', what: 'Bulk approve low-risk approvals', extra: 'Same tier and four-eyes rules per item' },
  // Control
  'agent.control': { role: 'MANAGER', what: 'Pause or limit the agent', extra: null },
  'simulator.use': { role: 'ADMIN', what: 'Use the simulator: scenarios, reset, undo reset', extra: 'OPS when DEMO_MODE is on' },
  // Administration
  'user.mfaReset': { role: 'ADMIN', what: 'Reset another user\'s MFA', extra: null },
  'user.sessionsRevoke': { role: 'ADMIN', what: 'Sign a user out of every browser', extra: null },
} as const satisfies Record<string, PermissionDef>;

export type Permission = keyof typeof PERMISSIONS;

export function roleFor(permission: Permission): Role {
  return PERMISSIONS[permission].role;
}

export function hasPermission(role: Role | null | undefined, permission: Permission): boolean {
  return role != null && roleAtLeast(role, PERMISSIONS[permission].role);
}

/** Markdown table for docs/02-architecture.md §7. The docs test compares the doc against this. */
export function permissionTableMarkdown(): string {
  const rows = (Object.keys(PERMISSIONS) as Permission[]).map((key) => {
    const p: PermissionDef = PERMISSIONS[key];
    return `| \`${key}\` | ${p.role} | ${p.what} | ${p.extra ?? '-'} |`;
  });
  return ['| Permission | Lowest role | What it allows | Extra rule |', '|---|---|---|---|', ...rows].join('\n');
}
