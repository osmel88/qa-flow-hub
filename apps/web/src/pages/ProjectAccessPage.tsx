import { ORGANIZATION_ROLES, outranksOrEquals } from '@qa-flow-hub/shared';
import type { OrganizationRoleName, ProjectMemberView } from '@qa-flow-hub/shared';
import { Badge, Button, DataState } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { projectsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { PageHeader } from '../components/PageHeader';
import { NoProject } from './NoProject';
import { useProject } from '../project/project-context';
import { humanize, toneFor } from '../components/status';

/**
 * Per-project roles.
 *
 * The screen exists to make one distinction visible, because it is the one
 * people get wrong: the organization role is what somebody is by default, the
 * project role is what they are *here*, and the effective role is what the API
 * will actually enforce. Showing only the last one would hide why it is what it
 * is; showing only the first is the bug this feature fixes.
 */
function reasonBlocked(
  actor: OrganizationRoleName,
  member: ProjectMemberView,
  isSelf: boolean,
): string | null {
  if (isSelf) {
    return 'You cannot change your own role in a project.';
  }
  if (member.organizationRole === 'organization_owner') {
    return 'An organization owner keeps full access to every project.';
  }
  if (!outranksOrEquals(actor, member.organizationRole)) {
    return `Your role here (${humanize(actor)}) cannot change somebody who is ${humanize(
      member.organizationRole,
    )}.`;
  }
  return null;
}

export function ProjectAccessPage(): React.JSX.Element {
  const { user, activeOrganization } = useAuth();
  const { activeProjectId, activeProject } = useProject();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const organizationRole = activeOrganization?.role ?? null;

  const members = useQuery({
    queryKey: ['project-members', activeProjectId],
    queryFn: () => projectsApi.members(activeProjectId ?? ''),
    enabled: activeProjectId !== null,
  });

  const grant = useMutation({
    mutationFn: (input: { userId: string; role: string }) =>
      projectsApi.grantRole(activeProjectId ?? '', input.userId, input.role),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['project-members'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not change the role.');
    },
  });

  const revoke = useMutation({
    mutationFn: (userId: string) => projectsApi.revokeRole(activeProjectId ?? '', userId),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['project-members'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not revoke the role.');
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  // The actor's own effective role in this project, not their organization one:
  // a project manager narrowed to viewer here should not be offered controls.
  const mine = members.data?.data.find((row) => row.userId === user?.id);
  const actorRole = mine?.effectiveRole ?? organizationRole;
  const canManage =
    actorRole === 'organization_owner' ||
    actorRole === 'organization_admin' ||
    actorRole === 'project_manager';

  return (
    <>
      <PageHeader
        title={`Access to ${activeProject?.key ?? 'this project'}`}
        description="A project role overrides the organization role, but only inside this project. Revoking it returns the member to their organization role."
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
          <caption className="visually-hidden">Effective roles in this project</caption>
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">In the organization</th>
              <th scope="col">In this project</th>
              <th scope="col">Enforced</th>
              {canManage && <th scope="col">Change</th>}
            </tr>
          </thead>
          <tbody>
            {members.data?.data.map((member) => {
              const reason = canManage
                ? reasonBlocked(
                    actorRole as OrganizationRoleName,
                    member,
                    member.userId === user?.id,
                  )
                : 'Only owners, admins and project managers change project roles.';
              const hintId = `project-role-hint-${member.userId}`;

              return (
                <tr key={member.userId}>
                  <td>
                    {member.fullName}
                    <div className="muted">{member.email}</div>
                  </td>
                  <td>{humanize(member.organizationRole)}</td>
                  <td>
                    {member.projectRole === null ? (
                      <span className="muted">Inherited</span>
                    ) : (
                      <Badge tone={toneFor(member.projectRole)}>
                        {humanize(member.projectRole)}
                      </Badge>
                    )}
                  </td>
                  <td>{humanize(member.effectiveRole)}</td>
                  {canManage && (
                    <td>
                      <select
                        className="ui-input"
                        aria-label={`Set the project role of ${member.email}`}
                        value=""
                        disabled={reason !== null}
                        {...(reason === null ? {} : { 'aria-describedby': hintId })}
                        onChange={(event) => {
                          grant.mutate({ userId: member.userId, role: event.target.value });
                        }}
                      >
                        <option value="">Choose…</option>
                        {ORGANIZATION_ROLES.filter(
                          (role) =>
                            outranksOrEquals(actorRole as OrganizationRoleName, role) &&
                            role !== member.projectRole,
                        ).map((role) => (
                          <option key={role} value={role}>
                            {humanize(role)}
                          </option>
                        ))}
                      </select>
                      {member.projectRole !== null && reason === null && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            revoke.mutate(member.userId);
                          }}
                        >
                          Revoke
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
              );
            })}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
