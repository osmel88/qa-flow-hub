import { z } from 'zod';
import { ORGANIZATION_ROLES, OrganizationRoleName } from '../auth/auth.contracts.js';

/**
 * Granular permissions (S2-F8).
 *
 * The model is layered, and every layer is a preset for the next:
 *
 *   organization role → project role (ProjectMember) → project overrides → effective permissions
 *
 * Roles did not go away. Each one still maps to a fixed set of permissions —
 * `ROLE_PERMISSIONS` — derived from what the same role could do before this
 * catalogue existed, so an installation with no overrides behaves exactly as
 * it did. Overrides only exist per (project, user) and only add or remove
 * single permissions; the organization keeps being governed by roles alone.
 *
 * Naming follows `<module>.<action>`. Two names deviate from the wording of the
 * original request to fit the codebase: `test_design.*` (the module that owns
 * suites, sections, cases and steps) instead of `testcases.*`, and
 * `project.manage` instead of `project.settings.manage`. Two `.manage` actions
 * were added (`requirements.manage`, `test_design.manage`) because the current
 * routes distinguish "edit" from "change status / delete", and collapsing them
 * would have silently widened `qa_lead`.
 */
export const PERMISSION_MODULES = [
  'requirements',
  'test_design',
  'testruns',
  'defects',
  'traceability',
  'attachments',
  'integrations',
  'members',
  'settings',
  'notifications',
  'analytics',
  'exports',
  'automation',
  'releases',
  'customization',
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export const PERMISSIONS = [
  'requirements.read',
  'requirements.write',
  'requirements.manage',
  'test_design.read',
  'test_design.write',
  'test_design.manage',
  'test_design.import',
  'testruns.read',
  'testruns.create',
  'testruns.execute',
  'testruns.manage',
  'defects.read',
  'defects.create',
  'defects.manage',
  'traceability.read',
  'traceability.manage',
  'attachments.read',
  'attachments.upload',
  'attachments.delete',
  'integrations.read',
  'integrations.manage',
  'members.read',
  'members.manage',
  'project.manage',
  'notifications.manage',
  'analytics.read',
  'data.export',
  'api_keys.manage',
  'releases.read',
  'releases.manage',
  'customization.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const permissionSchema = z.enum(PERMISSIONS);

export interface PermissionDescriptor {
  permission: Permission;
  module: PermissionModule;
  label: string;
  description: string;
}

export const PERMISSION_CATALOG: readonly PermissionDescriptor[] = [
  {
    permission: 'requirements.read',
    module: 'requirements',
    label: 'Read',
    description: 'View requirements and their history',
  },
  {
    permission: 'requirements.write',
    module: 'requirements',
    label: 'Write',
    description: 'Create, edit and delete requirements',
  },
  {
    permission: 'requirements.manage',
    module: 'requirements',
    label: 'Manage',
    description: 'Change requirement status (approve, deprecate…)',
  },
  {
    permission: 'test_design.read',
    module: 'test_design',
    label: 'Read',
    description: 'View suites, sections, cases and steps',
  },
  {
    permission: 'test_design.write',
    module: 'test_design',
    label: 'Write',
    description: 'Create and edit suites, sections, cases and steps; archive cases',
  },
  {
    permission: 'test_design.manage',
    module: 'test_design',
    label: 'Manage',
    description: 'Permanently delete suites and cases',
  },
  {
    permission: 'test_design.import',
    module: 'test_design',
    label: 'Import',
    description: 'Import cases, suites and sections from CSV files',
  },
  {
    permission: 'testruns.read',
    module: 'testruns',
    label: 'Read',
    description: 'View runs, their cases and results',
  },
  {
    permission: 'testruns.create',
    module: 'testruns',
    label: 'Plan',
    description: 'Create and edit runs, add cases, assign testers, start/complete/abort',
  },
  {
    permission: 'testruns.execute',
    module: 'testruns',
    label: 'Execute',
    description: 'Record results and import automated results',
  },
  {
    permission: 'testruns.manage',
    module: 'testruns',
    label: 'Manage',
    description: 'Delete runs',
  },
  { permission: 'defects.read', module: 'defects', label: 'Read', description: 'View defects' },
  {
    permission: 'defects.create',
    module: 'defects',
    label: 'Report',
    description: 'Create, edit and move defects through their workflow',
  },
  {
    permission: 'defects.manage',
    module: 'defects',
    label: 'Manage',
    description: 'Delete defects',
  },
  {
    permission: 'traceability.read',
    module: 'traceability',
    label: 'Read',
    description: 'View internal links and external references',
  },
  {
    permission: 'traceability.manage',
    module: 'traceability',
    label: 'Manage',
    description: 'Link and unlink requirements and cases',
  },
  {
    permission: 'attachments.read',
    module: 'attachments',
    label: 'Read',
    description: 'List, preview and download evidence',
  },
  {
    permission: 'attachments.upload',
    module: 'attachments',
    label: 'Upload',
    description: 'Attach evidence',
  },
  {
    permission: 'attachments.delete',
    module: 'attachments',
    label: 'Delete',
    description: 'Remove evidence',
  },
  {
    permission: 'integrations.read',
    module: 'integrations',
    label: 'Read',
    description: 'Browse connected providers and their data',
  },
  {
    permission: 'integrations.manage',
    module: 'integrations',
    label: 'Manage',
    description: 'Configure, connect and disconnect providers (organization-wide)',
  },
  {
    permission: 'members.read',
    module: 'members',
    label: 'Read',
    description: 'See who has access to the project',
  },
  {
    permission: 'members.manage',
    module: 'members',
    label: 'Manage',
    description: 'Grant project roles and permission overrides',
  },
  {
    permission: 'project.manage',
    module: 'settings',
    label: 'Manage project',
    description: 'Edit, archive and restore the project',
  },
  {
    permission: 'notifications.manage',
    module: 'notifications',
    label: 'Manage',
    description: 'Inspect the organization notification ledger and outbox',
  },
  {
    permission: 'analytics.read',
    module: 'analytics',
    label: 'Read',
    description: 'View the project dashboard',
  },
  {
    permission: 'data.export',
    module: 'exports',
    label: 'Export',
    description: 'Download cases, runs and the traceability matrix as CSV or a printable report',
  },
  {
    permission: 'api_keys.manage',
    module: 'automation',
    label: 'Manage API keys',
    description: 'Create and revoke the API keys CI uses to upload automated results',
  },
  {
    permission: 'releases.read',
    module: 'releases',
    label: 'Read',
    description: 'View releases, their runs, dashboard and traceability',
  },
  {
    permission: 'releases.manage',
    module: 'releases',
    label: 'Manage',
    description: 'Create, edit, start, release and archive releases',
  },
  {
    permission: 'customization.manage',
    module: 'customization',
    label: 'Manage',
    description: 'Define custom fields and configure the defect workflow of the project',
  },
];

export const PERMISSION_MODULE_LABELS: Record<PermissionModule, string> = {
  requirements: 'Requirements',
  test_design: 'Test Design',
  testruns: 'Executions',
  defects: 'Defects',
  traceability: 'Traceability',
  attachments: 'Attachments',
  integrations: 'Integrations',
  members: 'Members',
  settings: 'Settings',
  notifications: 'Notifications',
  analytics: 'Analytics',
  exports: 'Exports',
  automation: 'Automation',
  releases: 'Releases',
  customization: 'Customization',
};

const READ_ONLY: readonly Permission[] = [
  'requirements.read',
  'test_design.read',
  'testruns.read',
  'defects.read',
  'traceability.read',
  'attachments.read',
  'integrations.read',
  'members.read',
  'analytics.read',
  'data.export',
  'releases.read',
];

const TESTER: readonly Permission[] = [
  ...READ_ONLY,
  'testruns.execute',
  'defects.create',
  'traceability.manage',
  'attachments.upload',
  'attachments.delete',
];

const QA_LEAD: readonly Permission[] = [
  ...TESTER,
  'requirements.write',
  'test_design.write',
  'test_design.import',
  'testruns.create',
];

const PROJECT_MANAGER: readonly Permission[] = [
  ...QA_LEAD,
  'requirements.manage',
  'test_design.manage',
  'testruns.manage',
  'defects.manage',
  'members.manage',
  'project.manage',
  'api_keys.manage',
  'releases.manage',
  'customization.manage',
];

const ORGANIZATION_ADMIN: readonly Permission[] = [
  ...PROJECT_MANAGER,
  'integrations.manage',
  'notifications.manage',
];

/**
 * Role → default permissions. Each row is a superset of the one below it, which
 * is what `ROLE_RANK` already promised. `organization_owner` holds every
 * permission and is additionally exempt from overrides on the server.
 */
export const ROLE_PERMISSIONS: Record<OrganizationRoleName, readonly Permission[]> = {
  organization_owner: PERMISSIONS,
  organization_admin: ORGANIZATION_ADMIN,
  project_manager: PROJECT_MANAGER,
  qa_lead: QA_LEAD,
  tester: TESTER,
  viewer: READ_ONLY,
};

export function roleHasPermission(role: OrganizationRoleName, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Roles whose defaults include the permission, most powerful first. */
export function rolesWithPermission(permission: Permission): OrganizationRoleName[] {
  return ORGANIZATION_ROLES.filter((role) => roleHasPermission(role, permission));
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

export const PERMISSION_EFFECTS = ['grant', 'revoke'] as const;
export type PermissionEffectName = (typeof PERMISSION_EFFECTS)[number];

export const permissionOverrideSchema = z.object({
  permission: permissionSchema,
  effect: z.enum(PERMISSION_EFFECTS),
});
export type PermissionOverrideInput = z.infer<typeof permissionOverrideSchema>;

/**
 * Replaces the complete set of overrides one member has in one project. A full
 * replacement rather than add/remove calls so the UI and the audit log both
 * describe a state, not a sequence of deltas that has to be replayed.
 */
export const setPermissionOverridesSchema = z.object({
  overrides: z
    .array(permissionOverrideSchema)
    .max(PERMISSIONS.length)
    .superRefine((overrides, ctx) => {
      const seen = new Set<Permission>();
      for (const [index, override] of overrides.entries()) {
        if (seen.has(override.permission)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'permission'],
            message: `Duplicate override for ${override.permission}`,
          });
        }
        seen.add(override.permission);
      }
    }),
});
export type SetPermissionOverridesInput = z.infer<typeof setPermissionOverridesSchema>;

/** Where an effective permission (or its absence) comes from. */
export const PERMISSION_SOURCES = ['owner', 'role', 'override'] as const;
export type PermissionSource = (typeof PERMISSION_SOURCES)[number];

export interface EffectivePermissionView {
  permission: Permission;
  module: PermissionModule;
  granted: boolean;
  /**
   * `owner` — held because the member owns the organization; `override` — the
   * value was set by a project override (granted or revoked); `role` — the
   * effective project role decides.
   */
  source: PermissionSource;
}

export interface PermissionOverrideView {
  permission: Permission;
  effect: PermissionEffectName;
  grantedById: string | null;
  updatedAt: string;
}

export interface MemberPermissionsView {
  projectId: string;
  userId: string;
  organizationRole: OrganizationRoleName;
  /** `null` when no project grant exists: the organization role applies. */
  projectRole: OrganizationRoleName | null;
  /** Without access the project is invisible to them and `permissions` grants nothing. */
  hasAccess: boolean;
  effectiveRole: OrganizationRoleName;
  overrides: PermissionOverrideView[];
  permissions: EffectivePermissionView[];
}

/** Pure function shared by API and web so both render the same explanation. */
export function computeEffectivePermissions(
  effectiveRole: OrganizationRoleName,
  overrides: readonly PermissionOverrideInput[],
): EffectivePermissionView[] {
  const isOwner = effectiveRole === 'organization_owner';
  const byPermission = new Map(overrides.map((override) => [override.permission, override.effect]));

  return PERMISSION_CATALOG.map(({ permission, module }) => {
    if (isOwner) {
      return { permission, module, granted: true, source: 'owner' };
    }
    const effect = byPermission.get(permission);
    if (effect !== undefined) {
      return { permission, module, granted: effect === 'grant', source: 'override' };
    }
    return {
      permission,
      module,
      granted: roleHasPermission(effectiveRole, permission),
      source: 'role',
    };
  });
}
