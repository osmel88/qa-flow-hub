import { Button, DataState, TextField } from '@qa-flow-hub/ui';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { organizationsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { t } from '../i18n/i18n';

/**
 * The organization picker, and the only screen a brand-new user can reach:
 * without a tenant there is nothing else to show, so it doubles as the create
 * and accept-invitation surface.
 */
export function OrganizationsPage(): React.JSX.Element {
  const { organizations, activeOrganizationId, selectOrganization, refreshOrganizations } =
    useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => organizationsApi.create({ name, slug }),
    onSuccess: async (organization) => {
      await refreshOrganizations();
      selectOrganization(organization.id);
      void navigate('/dashboard');
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiError
          ? cause.message
          : t('organizations.couldNotCreateTheOrganization'),
      );
    },
  });

  const accept = useMutation({
    mutationFn: () => organizationsApi.acceptInvitation(token),
    onSuccess: async (joined) => {
      await refreshOrganizations();
      selectOrganization(joined.organizationId);
      void navigate('/dashboard');
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiError ? cause.message : t('organizations.couldNotAcceptTheInvitation'),
      );
    },
  });

  return (
    <main className="page">
      <PageHeader
        title={t('organizations.yourOrganizations')}
        description={t('organizations.pickOneToWorkIn')}
      />

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      <section className="card" aria-labelledby="pick-heading">
        <h2 id="pick-heading">{t('organizations.switchOrganization')}</h2>
        <DataState
          isPending={false}
          error={null}
          isEmpty={organizations.length === 0}
          emptyMessage={t('organizations.youDoNotBelongTo')}
        >
          <ul className="plain-list">
            {organizations.map((organization) => (
              <li key={organization.id}>
                <button
                  className="ui-button ui-button--secondary ui-button--sm"
                  aria-current={organization.id === activeOrganizationId || undefined}
                  onClick={() => {
                    selectOrganization(organization.id);
                    void navigate('/dashboard');
                  }}
                >
                  {organization.name} — {humanize(organization.role)}
                </button>
              </li>
            ))}
          </ul>
        </DataState>
      </section>

      <div className="grid-2">
        <section className="card" aria-labelledby="create-heading">
          <h2 id="create-heading">{t('organizations.createAnOrganization')}</h2>
          <TextField
            label={t('organizations.name')}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <TextField
            label={t('organizations.slug')}
            hint={t('organizations.lowercaseUsedInUrlsFor')}
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
            }}
          />
          <Button
            loading={create.isPending}
            disabled={name.trim() === '' || slug.trim() === ''}
            onClick={() => {
              create.mutate();
            }}
          >
            {t('organizations.create')}
          </Button>
        </section>

        <section className="card" aria-labelledby="join-heading">
          <h2 id="join-heading">{t('organizations.joinWithAnInvitation')}</h2>
          <TextField
            label={t('organizations.invitationToken')}
            hint={t('organizations.untilEmailDeliveryExistsAn')}
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
            }}
          />
          <Button
            variant="secondary"
            loading={accept.isPending}
            disabled={token.trim() === ''}
            onClick={() => {
              accept.mutate();
            }}
          >
            {t('organizations.join')}
          </Button>
        </section>
      </div>
    </main>
  );
}
