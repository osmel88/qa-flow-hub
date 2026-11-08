import { APPROVAL_TYPE_LABELS, APPROVAL_TYPES } from '@qa-flow-hub/shared';
import type { ApprovalType } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { environmentsApi, releaseApprovalsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';

/** Which approvals a release needs, project-wide or per environment (S6-F4). */
export function ApprovalRulesPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(activeProjectId);
  const manage = can('releases.manage');
  const projectId = activeProjectId ?? '';
  const [type, setType] = useState<ApprovalType>('qa');
  const [environmentId, setEnvironmentId] = useState('');
  const [required, setRequired] = useState('1');
  const [allowSelf, setAllowSelf] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rules = useQuery({
    queryKey: ['approval-rules', activeProjectId],
    queryFn: () => releaseApprovalsApi.rules(projectId),
    enabled: activeProjectId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const environments = useQuery({
    queryKey: ['environments', activeProjectId, 'approval-options'],
    queryFn: () => environmentsApi.list({ projectId }),
    enabled: activeProjectId !== null,
  });
  const refresh = async () => {
    setError(null);
    await queryClient.invalidateQueries({ queryKey: ['approval-rules'] });
  };
  const onError = (cause: unknown) => {
    setError(cause instanceof ApiError ? cause.message : 'Could not save the approval rule.');
  };
  const create = useMutation({
    mutationFn: () =>
      releaseApprovalsApi.createRule({
        projectId,
        type,
        requiredApprovals: Number(required),
        allowSelfApproval: allowSelf,
        ...(environmentId === '' ? {} : { environmentId }),
      }),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => releaseApprovalsApi.removeRule(id),
    onSuccess: refresh,
    onError,
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }
  return (
    <>
      <PageHeader
        title="Approval rules"
        description="Approvals a release needs; protected environments refuse deployments until they are complete."
      />
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {manage && (
        <form
          className="card"
          aria-label="Add an approval rule"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <SelectField
            label="Approval type"
            value={type}
            options={APPROVAL_TYPES.map((value) => ({
              value,
              label: APPROVAL_TYPE_LABELS[value],
            }))}
            onChange={(event) => {
              setType(event.target.value as ApprovalType);
            }}
          />
          <SelectField
            label="Approval environment"
            value={environmentId}
            options={[
              { value: '', label: 'Every environment' },
              ...(environments.data ?? []).map((env) => ({ value: env.id, label: env.name })),
            ]}
            onChange={(event) => {
              setEnvironmentId(event.target.value);
            }}
          />
          <label>
            Approvals needed{' '}
            <input
              type="number"
              min={1}
              max={10}
              value={required}
              onChange={(event) => {
                setRequired(event.target.value);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={allowSelf}
              onChange={(event) => {
                setAllowSelf(event.target.checked);
              }}
            />{' '}
            The release creator may approve
          </label>
          <Button type="submit" disabled={create.isPending}>
            Add approval rule
          </Button>
        </form>
      )}
      <DataState
        isPending={rules.isPending}
        error={rules.error}
        isEmpty={(rules.data?.length ?? 0) === 0}
        emptyMessage="No approval rule yet."
      >
        <section className="card">
          <ul aria-label="Approval rules">
            {(rules.data ?? []).map((rule) => (
              <li key={rule.id} data-testid={`approval-rule-${rule.type}`}>
                <strong>{APPROVAL_TYPE_LABELS[rule.type]}</strong> × {rule.requiredApprovals}{' '}
                <span className="muted">{rule.environment?.name ?? 'every environment'}</span>{' '}
                {rule.allowSelfApproval && <Badge tone="neutral">self-approval allowed</Badge>}
                {manage && (
                  <>
                    {' '}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        remove.mutate(rule.id);
                      }}
                    >
                      Delete {APPROVAL_TYPE_LABELS[rule.type]} rule
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      </DataState>
    </>
  );
}
