import type { Role } from '@payops/shared';

/**
 * What the UI offers to each role. The server enforces the same rules (requireRole, four-eyes);
 * this only decides which controls to show so a viewer is never handed a button that will 403.
 */
export type Capability = 'resolve' | 'decide' | 'simulate' | 'judge' | 'control' | 'assign' | 'note' | 'undo' | 'replay';

const MATRIX: Record<Capability, readonly Role[]> = {
  resolve: ['OPS', 'MANAGER', 'ADMIN'],
  decide: ['OPS', 'MANAGER', 'ADMIN'],
  // In demo mode the server lets OPS and above use the simulator.
  simulate: ['OPS', 'MANAGER', 'ADMIN'],
  // Judging a diagnosis (right or wrong); the server checks OPS as well.
  judge: ['OPS', 'MANAGER', 'ADMIN'],
  // Pausing or limiting the agent is a manager decision (D066).
  control: ['MANAGER', 'ADMIN'],
  // Taking a case or handing it back; the server checks OPS as well (D067).
  assign: ['OPS', 'MANAGER', 'ADMIN'],
  // Writing a case note; the server checks OPS as well (D068).
  note: ['OPS', 'MANAGER', 'ADMIN'],
  // Undoing a ledger post goes through a normal proposal; the server checks OPS as well (D070).
  undo: ['OPS', 'MANAGER', 'ADMIN'],
  // Replaying a webhook from the event log; the server checks OPS as well (D072).
  replay: ['OPS', 'MANAGER', 'ADMIN'],
};

export function can(role: Role | null | undefined, capability: Capability): boolean {
  return role != null && MATRIX[capability].includes(role);
}

export const ROLE_LABEL: Record<Role, string> = {
  VIEWER: 'Viewer',
  OPS: 'Ops analyst',
  MANAGER: 'Ops manager',
  ADMIN: 'Admin',
};

/** Shown in place of mutation controls for read-only users. */
export const VIEW_ONLY_NOTE = 'You have view access. Resolving and approving need an Ops or manager account.';
