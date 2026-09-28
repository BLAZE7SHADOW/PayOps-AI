import type { Role } from '@payops/shared';

/**
 * What the UI offers to each role. The server enforces the same rules (requireRole, four-eyes);
 * this only decides which controls to show so a viewer is never handed a button that will 403.
 */
export type Capability = 'resolve' | 'decide' | 'simulate';

const MATRIX: Record<Capability, readonly Role[]> = {
  resolve: ['OPS', 'MANAGER', 'ADMIN'],
  decide: ['OPS', 'MANAGER', 'ADMIN'],
  // The server runs the simulator in demo mode for OPS as well as ADMIN.
  simulate: ['OPS', 'ADMIN'],
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
