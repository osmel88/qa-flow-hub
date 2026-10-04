import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
  computeEffectivePermissions,
  roleHasPermission,
  setPermissionOverridesSchema,
} from './permission.contracts.js';

describe('permission catalog', () => {
  it('describes every permission exactly once', () => {
    expect(PERMISSION_CATALOG.map((entry) => entry.permission)).toEqual([...PERMISSIONS]);
  });

  it('keeps the role ladder monotonic: each role holds what the one below holds', () => {
    const ladder = [
      'viewer',
      'tester',
      'qa_lead',
      'project_manager',
      'organization_admin',
      'organization_owner',
    ] as const;
    for (let index = 1; index < ladder.length; index += 1) {
      const lower = ROLE_PERMISSIONS[ladder[index - 1]!];
      const higher = ROLE_PERMISSIONS[ladder[index]!];
      for (const permission of lower) {
        expect(higher, `${ladder[index]} lacks ${permission}`).toContain(permission);
      }
    }
    expect(ROLE_PERMISSIONS.organization_owner).toEqual([...PERMISSIONS]);
  });

  it('keeps the viewer read-only', () => {
    for (const permission of ROLE_PERMISSIONS.viewer) {
      expect(permission.endsWith('.read')).toBe(true);
    }
    expect(roleHasPermission('viewer', 'defects.create')).toBe(false);
    expect(roleHasPermission('tester', 'defects.create')).toBe(true);
  });
});

describe('computeEffectivePermissions', () => {
  it('gives an owner everything, from ownership, whatever the overrides say', () => {
    const view = computeEffectivePermissions('organization_owner', [
      { permission: 'requirements.read', effect: 'revoke' },
    ]);
    expect(view.every((entry) => entry.granted && entry.source === 'owner')).toBe(true);
  });

  it('applies grants and revokes on top of the role defaults and labels the source', () => {
    const view = computeEffectivePermissions('viewer', [
      { permission: 'requirements.write', effect: 'grant' },
      { permission: 'defects.read', effect: 'revoke' },
    ]);
    const byPermission = new Map(view.map((entry) => [entry.permission, entry]));
    expect(byPermission.get('requirements.write')).toMatchObject({
      granted: true,
      source: 'override',
    });
    expect(byPermission.get('defects.read')).toMatchObject({ granted: false, source: 'override' });
    expect(byPermission.get('requirements.read')).toMatchObject({ granted: true, source: 'role' });
    expect(byPermission.get('project.manage')).toMatchObject({ granted: false, source: 'role' });
  });
});

describe('setPermissionOverridesSchema', () => {
  it('accepts an empty list and rejects duplicates and unknown permissions', () => {
    expect(setPermissionOverridesSchema.safeParse({ overrides: [] }).success).toBe(true);
    expect(
      setPermissionOverridesSchema.safeParse({
        overrides: [
          { permission: 'defects.read', effect: 'grant' },
          { permission: 'defects.read', effect: 'revoke' },
        ],
      }).success,
    ).toBe(false);
    expect(
      setPermissionOverridesSchema.safeParse({
        overrides: [{ permission: 'admin_everything', effect: 'grant' }],
      }).success,
    ).toBe(false);
  });
});
