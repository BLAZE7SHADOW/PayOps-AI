import { describe, expect, it } from 'vitest';
import { ROLES } from './enums';
import { PERMISSIONS, hasPermission, permissionTableMarkdown, roleFor, type Permission } from './permissions';

describe('permissions', () => {
  it('ranks roles upward: a higher role keeps everything a lower one has', () => {
    for (const key of Object.keys(PERMISSIONS) as Permission[]) {
      const allowed = ROLES.filter((r) => hasPermission(r, key));
      expect(allowed[0]).toBe(roleFor(key));
      expect(allowed).toEqual(ROLES.slice(ROLES.indexOf(roleFor(key))));
    }
  });

  it('gives a signed-out user nothing', () => {
    expect(hasPermission(null, 'overview.view')).toBe(false);
    expect(hasPermission(undefined, 'case.view')).toBe(false);
  });

  it('keeps viewers read-only and managers in charge of the agent', () => {
    expect(hasPermission('VIEWER', 'resolution.propose')).toBe(false);
    expect(hasPermission('OPS', 'agent.control')).toBe(false);
    expect(hasPermission('MANAGER', 'agent.control')).toBe(true);
    expect(hasPermission('MANAGER', 'user.mfaReset')).toBe(false);
    expect(hasPermission('ADMIN', 'user.mfaReset')).toBe(true);
  });

  it('renders one row per permission', () => {
    const lines = permissionTableMarkdown().split('\n');
    expect(lines).toHaveLength(2 + Object.keys(PERMISSIONS).length);
  });
});
