import {
  FLAG_RULES,
  PERCENT_RULES,
  QUALITY_GATE_RULE_LABELS,
  QUALITY_GATE_RULE_TYPES,
} from '@qa-flow-hub/shared';
import type { QualityGateRuleType } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { environmentsApi, qualityGatesApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';

type Draft = Record<QualityGateRuleType, { on: boolean; threshold: string }>;
const emptyDraft = (): Draft =>
  Object.fromEntries(
    QUALITY_GATE_RULE_TYPES.map((type) => [
      type,
      { on: false, threshold: PERCENT_RULES.includes(type) ? '80' : '0' },
    ]),
  ) as Draft;

/** Quality gates of the project (S6-F3): rules, scope and whether they are required. */
export function QualityGatesPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(activeProjectId);
  const manage = can('releases.manage');
  const projectId = activeProjectId ?? '';
  const [name, setName] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [required, setRequired] = useState(true);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const gates = useQuery({
    queryKey: ['quality-gates', activeProjectId],
    queryFn: () => qualityGatesApi.list(projectId),
    enabled: activeProjectId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const environments = useQuery({
    queryKey: ['environments', activeProjectId, 'gate-options'],
    queryFn: () => environmentsApi.list({ projectId }),
    enabled: activeProjectId !== null,
  });
  const refresh = async () => {
    setError(null);
    await queryClient.invalidateQueries({ queryKey: ['quality-gates'] });
  };
  const onError = (cause: unknown) => {
    setError(cause instanceof ApiError ? cause.message : 'Could not save the quality gate.');
  };
  const create = useMutation({
    mutationFn: () =>
      qualityGatesApi.create({
        projectId,
        name: name.trim(),
        required,
        enabled: true,
        ...(environmentId === '' ? {} : { environmentId }),
        rules: QUALITY_GATE_RULE_TYPES.filter((type) => draft[type].on).map((type) => ({
          type,
          threshold: FLAG_RULES.includes(type) ? null : Number(draft[type].threshold),
        })),
      }),
    onSuccess: async () => {
      setName('');
      setDraft(emptyDraft());
      await refresh();
    },
    onError,
  });
  const toggle = useMutation({
    mutationFn: (gate: { id: string; enabled: boolean; version: number }) =>
      qualityGatesApi.update(gate.id, { enabled: !gate.enabled, version: gate.version }),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => qualityGatesApi.remove(id),
    onSuccess: refresh,
    onError,
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }
  return (
    <>
      <PageHeader
        title="Quality gates"
        description="Rules a release must meet; required gates guard protected environments."
      />
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {manage && (
        <form
          className="card"
          aria-label="Add a quality gate"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <h2>Add a quality gate</h2>
          <TextField
            label="Gate name"
            value={name}
            required
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <SelectField
            label="Gate environment"
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
            <input
              type="checkbox"
              checked={required}
              onChange={(event) => {
                setRequired(event.target.checked);
              }}
            />{' '}
            Required (blocks protected environments)
          </label>
          <fieldset>
            <legend>Rules</legend>
            {QUALITY_GATE_RULE_TYPES.map((type) => (
              <div key={type}>
                <label>
                  <input
                    type="checkbox"
                    checked={draft[type].on}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        [type]: { ...current[type], on: event.target.checked },
                      }));
                    }}
                  />{' '}
                  {QUALITY_GATE_RULE_LABELS[type]}
                </label>{' '}
                {!FLAG_RULES.includes(type) && (
                  <input
                    type="number"
                    min={0}
                    max={PERCENT_RULES.includes(type) ? 100 : undefined}
                    aria-label={`${QUALITY_GATE_RULE_LABELS[type]} threshold`}
                    value={draft[type].threshold}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        [type]: { ...current[type], threshold: event.target.value },
                      }));
                    }}
                  />
                )}
              </div>
            ))}
          </fieldset>
          <Button type="submit" disabled={create.isPending}>
            Add quality gate
          </Button>
        </form>
      )}
      <DataState
        isPending={gates.isPending}
        error={gates.error}
        isEmpty={(gates.data?.length ?? 0) === 0}
        emptyMessage="No quality gate yet."
      >
        <section className="card">
          <ul aria-label="Quality gates">
            {(gates.data ?? []).map((gate) => (
              <li key={gate.id} data-testid={`quality-gate-${gate.name}`}>
                <strong>{gate.name}</strong>{' '}
                <span className="muted">{gate.environment?.name ?? 'every environment'}</span>{' '}
                <Badge tone={gate.required ? 'warning' : 'neutral'}>
                  {gate.required ? 'required' : 'advisory'}
                </Badge>{' '}
                {!gate.enabled && <Badge tone="neutral">disabled</Badge>}
                <ul>
                  {gate.rules.map((rule) => (
                    <li key={rule.type}>
                      {QUALITY_GATE_RULE_LABELS[rule.type]}
                      {rule.threshold !== null && `: ${rule.threshold}`}
                    </li>
                  ))}
                </ul>
                {manage && (
                  <p>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        toggle.mutate(gate);
                      }}
                    >
                      {gate.enabled ? 'Disable' : 'Enable'} {gate.name}
                    </Button>{' '}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        remove.mutate(gate.id);
                      }}
                    >
                      Delete {gate.name}
                    </Button>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      </DataState>
    </>
  );
}
