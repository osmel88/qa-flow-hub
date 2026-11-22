import { organizationCapabilities } from '@qa-flow-hub/shared';
import { describe, expect, it } from 'vitest';
import { hasCapability } from './capabilities';

const base = { id: 'o', name: 'Acme', slug: 'acme', requireMfa: false } as const;

describe('hasCapability', () => {
  it('reads what the API put in the session', () => {
    const organization = {
      ...base,
      role: 'organization_owner' as const,
      capabilities: { ...organizationCapabilities('organization_owner'), manageBilling: false },
    };
    expect(hasCapability(organization, 'manageBilling')).toBe(false);
    expect(hasCapability(organization, 'manageMembers')).toBe(true);
  });

  it('falls back to the shared rule for a session stored without capabilities', () => {
    expect(hasCapability({ ...base, role: 'organization_admin' }, 'readBilling')).toBe(true);
    expect(hasCapability({ ...base, role: 'organization_admin' }, 'manageBilling')).toBe(false);
    expect(hasCapability({ ...base, role: 'tester' }, 'inspectNotifications')).toBe(false);
  });

  it('denies everything without an organization', () => {
    expect(hasCapability(null, 'createProjects')).toBe(false);
    expect(hasCapability(undefined, 'readAuditLog')).toBe(false);
  });
});
