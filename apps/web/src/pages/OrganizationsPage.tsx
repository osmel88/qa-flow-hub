import { Button, DataState, TextField } from '@qa-flow-hub/ui';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { organizationsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { PageHeader } from '../components/PageHeader';

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
      setError(cause instanceof ApiError ? cause.message : 'Could not create the organization.');
    },
  });

  const accept = useMutation({
    mutationFn: () => organizationsApi.acceptInvitation(token),
    onSuccess: async (organization) => {
      await refreshOrganizations();
      selectOrganization(organization.id);
      void navigate('/dashboard');
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not accept the invitation.');
    },
  });

  return (
    <main className="page">
      <PageHeader
        title="Your organizations"
        description="Pick one to work in, create your own, or join with an invitation token."
      />

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      <section className="card" aria-labelledby="pick-heading">
        <h2 id="pick-heading">Switch organization</h2>
        <DataState
          isPending={false}
          error={null}
          isEmpty={organizations.length === 0}
          emptyMessage="You do not belong to any organization yet."
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
                  {organization.name} — {organization.role.replace(/_/g, ' ')}
                </button>
              </li>
            ))}
          </ul>
        </DataState>
      </section>

      <div className="grid-2">
        <section className="card" aria-labelledby="create-heading">
          <h2 id="create-heading">Create an organization</h2>
          <TextField
            label="Name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <TextField
            label="Slug"
            hint="Lowercase, used in URLs. For example: acme-qa"
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
            Create
          </Button>
        </section>

        <section className="card" aria-labelledby="join-heading">
          <h2 id="join-heading">Join with an invitation</h2>
          <TextField
            label="Invitation token"
            hint="Until email delivery exists, an admin passes this token to you directly."
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
            Join
          </Button>
        </section>
      </div>
    </main>
  );
}
