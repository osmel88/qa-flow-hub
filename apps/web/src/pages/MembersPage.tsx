import { ORGANIZATION_ROLES } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { organizationsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';

const INVITABLE = ORGANIZATION_ROLES.filter((role) => role !== 'organization_owner');

export function MembersPage(): React.JSX.Element {
  const { user, activeOrganization } = useAuth();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('tester');
  const [error, setError] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  const canManage =
    activeOrganization?.role === 'organization_owner' ||
    activeOrganization?.role === 'organization_admin';

  const members = useQuery({ queryKey: ['members'], queryFn: () => organizationsApi.members() });
  const invitations = useQuery({
    queryKey: ['invitations'],
    queryFn: () => organizationsApi.invitations(),
    enabled: canManage,
  });

  const invite = useMutation({
    mutationFn: () => organizationsApi.invite({ email, role: role as 'tester' }),
    onSuccess: async (created) => {
      setEmail('');
      setError(null);
      // The plaintext token is shown once and never stored. Until email
      // delivery exists this is the only way it reaches the invited person.
      setIssuedToken(created.token);
      await queryClient.invalidateQueries({ queryKey: ['invitations'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not send the invitation.');
    },
  });

  const changeRole = useMutation({
    mutationFn: (input: { userId: string; role: string }) =>
      organizationsApi.updateMember(input.userId, input.role),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not change the role.');
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => organizationsApi.revokeInvitation(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['invitations'] });
    },
  });

  return (
    <>
      <PageHeader
        title="Members and roles"
        description="Nobody can grant a role above their own, and the last owner cannot be demoted."
      />

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      {canManage && (
        <section className="card" aria-labelledby="invite-heading">
          <h2 id="invite-heading">Invite someone</h2>
          <TextField
            label="Email"
            type="email"
            hint="The person does not need an account yet."
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <SelectField
            label="Role"
            options={INVITABLE.map((value) => ({ value, label: humanize(value) }))}
            value={role}
            onChange={(event) => {
              setRole(event.target.value);
            }}
          />
          <Button
            loading={invite.isPending}
            disabled={email.trim() === ''}
            onClick={() => {
              invite.mutate();
            }}
          >
            Send invitation
          </Button>

          {issuedToken !== null && (
            <div className="callout" role="status">
              <p>
                Copy this token and pass it to the invited person. It is shown once and cannot be
                recovered.
              </p>
              <code className="token">{issuedToken}</code>
            </div>
          )}
        </section>
      )}

      <DataState
        isPending={members.isPending}
        error={members.error}
        isEmpty={(members.data?.data.length ?? 0) === 0}
      >
        <table className="table card">
          <caption className="visually-hidden">Members of this organization</caption>
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              {canManage && <th scope="col">Change role</th>}
            </tr>
          </thead>
          <tbody>
            {members.data?.data.map((member) => (
              <tr key={member.userId}>
                <td>
                  {member.fullName}
                  <div className="muted">{member.email}</div>
                </td>
                <td>{humanize(member.role)}</td>
                <td>
                  <Badge tone={toneFor(member.status)}>{humanize(member.status)}</Badge>
                </td>
                {canManage && (
                  <td>
                    <select
                      className="ui-input"
                      aria-label={`Change role of ${member.email}`}
                      value=""
                      // Changing your own role is refused by the API; disabling
                      // it here keeps the UI from offering an action that fails.
                      disabled={member.userId === user?.id}
                      onChange={(event) => {
                        changeRole.mutate({ userId: member.userId, role: event.target.value });
                      }}
                    >
                      <option value="">Choose…</option>
                      {ORGANIZATION_ROLES.filter((value) => value !== member.role).map((value) => (
                        <option key={value} value={value}>
                          {humanize(value)}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>

      {canManage && (
        <section className="card" aria-labelledby="pending-heading">
          <h2 id="pending-heading">Pending invitations</h2>
          <DataState
            isPending={invitations.isPending}
            error={invitations.error}
            isEmpty={(invitations.data?.length ?? 0) === 0}
            emptyMessage="No invitation is pending."
          >
            <ul className="plain-list">
              {invitations.data?.map((invitation) => (
                <li key={invitation.id}>
                  {invitation.email} — {humanize(invitation.role)} —{' '}
                  <Badge tone={toneFor(invitation.status)}>{humanize(invitation.status)}</Badge>{' '}
                  {invitation.status === 'pending' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        revoke.mutate(invitation.id);
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </DataState>
        </section>
      )}
    </>
  );
}
