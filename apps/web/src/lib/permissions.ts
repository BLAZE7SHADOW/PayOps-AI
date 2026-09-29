import { hasPermission, type Permission, type Role } from '@payops/shared';

/**
 * What the UI offers to each role. It reads the shared permission table, the same one the server
 * enforces, so a viewer is never handed a button that will 403.
 */
export type Capability = 'resolve' | 'decide' | 'simulate' | 'judge' | 'control' | 'assign' | 'note' | 'undo' | 'replay';

const CAPABILITY_PERMISSION: Record<Capability, Permission> = {
  resolve: 'resolution.propose',
  decide: 'approval.decide',
  // The server lowers this to OPS in demo mode; the UI follows the demo behaviour.
  simulate: 'simulator.use',
  judge: 'run.feedback',
  control: 'agent.control',
  assign: 'case.assign',
  note: 'case.note',
  undo: 'resolution.undo',
  replay: 'webhook.replay',
};

export function can(role: Role | null | undefined, capability: Capability): boolean {
  if (capability === 'simulate') return hasPermission(role, 'resolution.propose');
  return hasPermission(role, CAPABILITY_PERMISSION[capability]);
}

export const ROLE_LABEL: Record<Role, string> = {
  VIEWER: 'Viewer',
  OPS: 'Ops analyst',
  MANAGER: 'Ops manager',
  ADMIN: 'Admin',
};

/** Shown in place of mutation controls for read-only users. */
export const VIEW_ONLY_NOTE = 'You have view access. Resolving and approving need an Ops or manager account.';
