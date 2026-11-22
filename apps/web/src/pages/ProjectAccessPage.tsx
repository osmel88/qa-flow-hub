import {
  ORGANIZATION_ROLES,
  hasOrganizationCapability,
  outranksOrEquals,
} from '@qa-flow-hub/shared';
import type { OrganizationRoleName, Permission, ProjectMemberView } from '@qa-flow-hub/shared';
import { Badge, Button, DataState } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { permissionsApi, projectsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { MemberPermissionsPanel } from '../components/MemberPermissionsPanel';
import { PageHeader } from '../components/PageHeader';
import { NoProject } from './NoProject';
import { useProject } from '../project/project-context';
import { humanize, toneFor } from '../components/status';
import { t } from '../i18n/i18n';

/**
 * Per-project roles.
 *
 * The screen exists to make one distinction visible, because it is the one
 * people get wrong: the organization role is what somebody is by default, the
 * project role is what they are *here*, and the effective role is what the API
 * will actually enforce. Showing only the last one would hide why it is what it
 * is; showing only the first is the bug this feature fixes.
 */
const ORGANIZATION_ROLE_OPTION = '__organization_role';

/** Owners and admins see every project; everybody else needs a grant. */
function seesEveryProject(role: OrganizationRoleName): boolean {
  return hasOrganizationCapability(role, 'seeEveryProject');
}

function reasonBlocked(
  actor: OrganizationRoleName,
  member: ProjectMemberView,
  isSelf: boolean,
): string | null {
  if (isSelf) {
    return t('projectAccess.youCannotChangeYourOwn');
  }
  if (member.organizationRole === 'organization_owner') {
    return t('projectAccess.anOrganizationOwnerKeepsFull');
  }
  if (!outranksOrEquals(actor, member.organizationRole)) {
    return t('projectAccess.yourRoleHereCannotChange', {
      value: humanize(actor),
      value2: humanize(member.organizationRole),
    });
  }
  return null;
}

export function ProjectAccessPage(): React.JSX.Element {
  const { user, activeOrganization } = useAuth();
  const { activeProjectId, activeProject } = useProject();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const organizationRole = activeOrganization?.role ?? null;

  const members = useQuery({
    queryKey: ['project-members', activeProjectId],
    queryFn: () => projectsApi.members(activeProjectId ?? ''),
    enabled: activeProjectId !== null,
  });

  const myPermissions = useQuery({
    queryKey: ['member-permissions', activeProjectId, 'me'],
    queryFn: () => permissionsApi.mine(activeProjectId ?? ''),
    enabled: activeProjectId !== null,
  });

  const grant = useMutation({
    mutationFn: (input: { userId: string; role: string | null }) =>
      projectsApi.grantRole(activeProjectId ?? '', input.userId, input.role),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['project-members'] });
      await queryClient.invalidateQueries({ queryKey: ['member-permissions'] });
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiError ? cause.message : t('projectAccess.couldNotChangeTheRole'),
      );
    },
  });

  const revoke = useMutation({
    mutationFn: (userId: string) => projectsApi.revokeRole(activeProjectId ?? '', userId),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['project-members'] });
      await queryClient.invalidateQueries({ queryKey: ['member-permissions'] });
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiError ? cause.message : t('projectAccess.couldNotRevokeTheRole'),
      );
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  // The actor's own effective role in this project, not their organization one:
  // a project manager narrowed to viewer here should not be offered controls.
  const mine = members.data?.data.find((row) => row.userId === user?.id);
  const actorRole: OrganizationRoleName =
    myPermissions.data?.effectiveRole ?? mine?.effectiveRole ?? organizationRole ?? 'viewer';
  // `members.manage` is what the API checks, so it is what decides here too —
  // an override can hand it to a qa_lead or take it from a project manager.
  const actorPermissions = new Set<Permission>(
    myPermissions.data?.permissions
      .filter((entry) => entry.granted)
      .map((entry) => entry.permission) ?? [],
  );
  const canManage = actorPermissions.has('members.manage');

  return (
    <>
      <PageHeader
        title={t('projectAccess.accessTo', { value: activeProject?.key ?? 'this project' })}
        description={t('projectAccess.ownersAndAdminsSeeEvery')}
      />

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      <DataState
        isPending={members.isPending}
        error={members.error}
        isEmpty={(members.data?.data.length ?? 0) === 0}
      >
        <table className="table card">
          <caption className="visually-hidden">
            {t('projectAccess.effectiveRolesInThisProject')}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('projectAccess.member')}</th>
              <th scope="col">{t('projectAccess.inTheOrganization')}</th>
              <th scope="col">{t('projectAccess.inThisProject')}</th>
              <th scope="col">{t('projectAccess.enforced')}</th>
              <th scope="col">{t('projectAccess.permissions')}</th>
              {canManage && <th scope="col">{t('projectAccess.change')}</th>}
            </tr>
          </thead>
          <tbody>
            {members.data?.data.map((member) => {
              const reason = canManage
                ? reasonBlocked(actorRole, member, member.userId === user?.id)
                : t('projectAccess.onlyManagersChangeRoles');
              const hintId = `project-role-hint-${member.userId}`;
              const isExpanded = expanded === member.userId;
              const columns = canManage ? 6 : 5;

              return (
                <Fragment key={member.userId}>
                  <tr>
                    <td>
                      {member.fullName}
                      <div className="muted">{member.email}</div>
                    </td>
                    <td>{humanize(member.organizationRole)}</td>
                    <td>
                      {!member.hasAccess ? (
                        <span className="muted">{t('projectAccess.noAccess')}</span>
                      ) : member.projectRole === null ? (
                        <span className="muted">{t('projectAccess.inherited')}</span>
                      ) : (
                        <Badge tone={toneFor(member.projectRole)}>
                          {humanize(member.projectRole)}
                        </Badge>
                      )}
                    </td>
                    <td>
                      {member.effectiveRole === null ? (
                        <span className="muted">{t('projectAccess.cannotSeeThisProject')}</span>
                      ) : (
                        humanize(member.effectiveRole)
                      )}
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-expanded={isExpanded}
                        aria-label={t('projectAccess.thePermissionsOf', {
                          value: isExpanded ? 'Hide' : 'Show',
                          email: member.email,
                        })}
                        onClick={() => {
                          setExpanded(isExpanded ? null : member.userId);
                        }}
                      >
                        {isExpanded ? t('projectAccess.hide') : t('projectAccess.show')}
                      </Button>
                    </td>
                    {canManage && (
                      <td>
                        <select
                          className="ui-input"
                          aria-label={t('projectAccess.setTheProjectRoleOf', {
                            email: member.email,
                          })}
                          value=""
                          disabled={reason !== null}
                          {...(reason === null ? {} : { 'aria-describedby': hintId })}
                          onChange={(event) => {
                            const value = event.target.value;
                            grant.mutate({
                              userId: member.userId,
                              role: value === ORGANIZATION_ROLE_OPTION ? null : value,
                            });
                          }}
                        >
                          <option value="">{t('projectAccess.choose')}</option>
                          {(!member.hasAccess || member.projectRole !== null) && (
                            <option value={ORGANIZATION_ROLE_OPTION}>
                              {t('projectAccess.accessWithTheirOrganizationRole')}
                            </option>
                          )}
                          {ORGANIZATION_ROLES.filter(
                            (role) =>
                              outranksOrEquals(actorRole, role) && role !== member.projectRole,
                          ).map((role) => (
                            <option key={role} value={role}>
                              {humanize(role)}
                            </option>
                          ))}
                        </select>
                        {member.grantedAt !== null && reason === null && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              revoke.mutate(member.userId);
                            }}
                          >
                            {seesEveryProject(member.organizationRole)
                              ? t('projectAccess.revoke')
                              : t('projectAccess.removeAccess')}
                          </Button>
                        )}
                        {reason !== null && (
                          <p className="muted" id={hintId}>
                            {reason}
                          </p>
                        )}
                      </td>
                    )}
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={columns}>
                        <MemberPermissionsPanel
                          projectId={activeProjectId}
                          userId={member.userId}
                          email={member.email}
                          canEdit={canManage && member.userId !== user?.id}
                          actorPermissions={actorPermissions}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
