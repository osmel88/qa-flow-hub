import { organizationCapabilities } from '@qa-flow-hub/shared';
import type { OrganizationCapability, OrganizationSummary } from '@qa-flow-hub/shared';

/**
 * What the API will accept from the caller in this organization. It reads the
 * session's `capabilities` (computed by the API) and, for a session stored by
 * an older client, the same shared rule the API guards use — never a role list
 * of its own. Hiding a control is a convenience; the API still decides.
 */
export function hasCapability(
  organization: OrganizationSummary | null | undefined,
  capability: OrganizationCapability,
): boolean {
  if (organization === null || organization === undefined) return false;
  const capabilities = organization.capabilities ?? organizationCapabilities(organization.role);
  return capabilities[capability];
}
