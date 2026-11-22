import { ORGANIZATION_ROLES, invitableRoleSchema, outranksOrEquals } from '@qa-flow-hub/shared';
import type { MemberView, OrganizationRoleName } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { organizationsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { hasCapability } from '../auth/capabilities';
import { PageHeader } from '../components/PageHeader';
import { PlanLimitAlert } from '../components/PlanLimitAlert';
import { humanize, toneFor } from '../components/status';
import { t } from '../i18n/i18n';

/**
 * The rules the API enforces, mirrored here so the screen stops offering moves
 * that come back as a 403. The API is still the authority: this only decides
 * what is worth showing, and every disabled control says why.
 */
function assignableRoles(actor: OrganizationRoleName): OrganizationRoleName[] {
  return ORGANIZATION_ROLES.filter((role) => outranksOrEquals(actor, role));
}

function blockedReason(
  actor: OrganizationRoleName,
  member: MemberView,
  isSelf: boolean,
): string | null {
  if (isSelf) {
    return t('members.youCannotChangeYourOwn');
  }
  if (!outranksOrEquals(actor, member.role)) {
    return t('members.yourRoleCannotChangeA', {
      value: humanize(actor),
      value2: humanize(member.role),
    });
  }
  return null;
}

function RoleCell({
  actorRole,
  member,
  isSelf,
  onChange,
}: {
  actorRole: OrganizationRoleName;
  member: MemberView;
  isSelf: boolean;
  onChange: (role: string) => void;
}): React.JSX.Element {
  const reason = blockedReason(actorRole, member, isSelf);
  const hintId = `role-hint-${member.userId}`;

  return (
    <>
      <select
        className="ui-input"
        aria-label={t('members.changeRoleOf', { email: member.email })}
        value=""
        disabled={reason !== null}
        {...(reason === null ? {} : { 'aria-describedby': hintId })}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{t('members.choose')}</option>
        {assignableRoles(actorRole)
          .filter((value) => value !== member.role)
          .map((value) => (
            <option key={value} value={value}>
              {humanize(value)}
            </option>
          ))}
      </select>
      {reason !== null && (
        <p className="muted" id={hintId}>
          {reason}
        </p>
      )}
    </>
  );
}

/**
 * Owner-only switch. Turning it on from a session without MFA is refused by
 * the API, because the owner would be locked out on the next request.
 */
function MfaPolicy(): React.JSX.Element {
  const { activeOrganization, refreshOrganizations } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (requireMfa: boolean) => organizationsApi.update({ requireMfa }),
    onSuccess: async () => {
      setError(null);
      await refreshOrganizations();
      await queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('members.couldNotChangeThePolicy'));
    },
  });

  return (
    <section className="card" aria-labelledby="mfa-policy-heading">
      <h2 id="mfa-policy-heading">{t('members.security')}</h2>
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={activeOrganization?.requireMfa === true}
          disabled={update.isPending}
          onChange={(event) => update.mutate(event.target.checked)}
        />
        {t('members.requireMultiFactorAuthentication')}
      </label>
      <p className="muted">{t('members.membersWhoseSessionDidNot')}</p>
    </section>
  );
}

export function MembersPage(): React.JSX.Element {
  const { user, activeOrganization } = useAuth();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('tester');
  const [error, setError] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  const actorRole = activeOrganization?.role ?? null;
  const canManage = hasCapability(activeOrganization, 'manageMembers');
  // Two rules narrow the list: ownership is never handed out by invitation, and
  // nobody invites somebody more powerful than themselves.
  const invitable =
    actorRole === null
      ? []
      : invitableRoleSchema.options.filter((role) => outranksOrEquals(actorRole, role));

  const members = useQuery({
    queryKey: ['members', activeOrganization?.id],
    queryFn: () => organizationsApi.members(),
  });
  const invitations = useQuery({
    queryKey: ['invitations', activeOrganization?.id],
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
      await queryClient.invalidateQueries({ queryKey: ['billing'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('members.couldNotSendTheInvitation'));
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
      setError(cause instanceof ApiError ? cause.message : t('members.couldNotChangeTheRole'));
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => organizationsApi.revokeInvitation(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['invitations'] });
      await queryClient.invalidateQueries({ queryKey: ['billing'] });
    },
  });

  return (
    <>
      <PageHeader
        title={t('members.membersAndRoles')}
        description={t('members.nobodyCanGrantARole')}
      />

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      {hasCapability(activeOrganization, 'manageOrganization') && <MfaPolicy />}

      {canManage && (
        <section className="card" aria-labelledby="invite-heading">
          <h2 id="invite-heading">{t('members.inviteSomeone')}</h2>
          <PlanLimitAlert error={invite.error} />
          <TextField
            label={t('members.email')}
            type="email"
            hint={t('members.thePersonDoesNotNeed')}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <SelectField
            label={t('members.role')}
            hint={t('members.youCanOnlyInviteSomebody')}
            options={invitable.map((value) => ({ value, label: humanize(value) }))}
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
            {t('members.sendInvitation')}
          </Button>

          {issuedToken !== null && (
            <div className="callout" role="status">
              <p>{t('members.copyThisTokenAndPass')}</p>
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
          <caption className="visually-hidden">{t('members.membersOfThisOrganization')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('members.member')}</th>
              <th scope="col">{t('members.role')}</th>
              <th scope="col">{t('members.status')}</th>
              <th scope="col">{t('members.mfa')}</th>
              {canManage && <th scope="col">{t('members.changeRole')}</th>}
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
                <td>{member.mfaEnabled ? t('members.enabled') : t('members.off')}</td>
                {canManage && actorRole !== null && (
                  <td>
                    <RoleCell
                      actorRole={actorRole}
                      member={member}
                      isSelf={member.userId === user?.id}
                      onChange={(next) => {
                        changeRole.mutate({ userId: member.userId, role: next });
                      }}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>

      {canManage && (
        <section className="card" aria-labelledby="pending-heading">
          <h2 id="pending-heading">{t('members.pendingInvitations')}</h2>
          <DataState
            isPending={invitations.isPending}
            error={invitations.error}
            isEmpty={(invitations.data?.length ?? 0) === 0}
            emptyMessage={t('members.noInvitationIsPending')}
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
                      {t('members.revoke')}
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
