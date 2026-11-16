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
import { t } from '../i18n/i18n';

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
    setError(
      cause instanceof ApiError ? cause.message : t('approvalRules.couldNotSaveTheApproval'),
    );
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
        title={t('approvalRules.approvalRules')}
        description={t('approvalRules.approvalsAReleaseNeedsProtected')}
      />
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {manage && (
        <form
          className="card"
          aria-label={t('approvalRules.addAnApprovalRule')}
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <SelectField
            label={t('approvalRules.approvalType')}
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
            label={t('approvalRules.approvalEnvironment')}
            value={environmentId}
            options={[
              { value: '', label: t('approvalRules.everyEnvironment') },
              ...(environments.data ?? []).map((env) => ({ value: env.id, label: env.name })),
            ]}
            onChange={(event) => {
              setEnvironmentId(event.target.value);
            }}
          />
          <label>
            {t('approvalRules.approvalsNeeded')}{' '}
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
            {t('approvalRules.theReleaseCreatorMayApprove')}
          </label>
          <Button type="submit" disabled={create.isPending}>
            {t('approvalRules.addApprovalRule')}
          </Button>
        </form>
      )}
      <DataState
        isPending={rules.isPending}
        error={rules.error}
        isEmpty={(rules.data?.length ?? 0) === 0}
        emptyMessage={t('approvalRules.noApprovalRuleYet')}
      >
        <section className="card">
          <ul aria-label={t('approvalRules.approvalRules')}>
            {(rules.data ?? []).map((rule) => (
              <li key={rule.id} data-testid={`approval-rule-${rule.type}`}>
                <strong>{APPROVAL_TYPE_LABELS[rule.type]}</strong> × {rule.requiredApprovals}{' '}
                <span className="muted">
                  {rule.environment?.name ?? t('approvalRules.everyEnvironment2')}
                </span>{' '}
                {rule.allowSelfApproval && (
                  <Badge tone="neutral">{t('approvalRules.selfApprovalAllowed')}</Badge>
                )}
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
                      {t('approvalRules.delete')} {APPROVAL_TYPE_LABELS[rule.type]}{' '}
                      {t('approvalRules.rule')}
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
