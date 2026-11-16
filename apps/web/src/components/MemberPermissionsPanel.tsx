import {
  PERMISSION_CATALOG,
  PERMISSION_MODULES,
  PERMISSION_MODULE_LABELS,
  computeEffectivePermissions,
} from '@qa-flow-hub/shared';
import type {
  MemberPermissionsView,
  Permission,
  PermissionEffectName,
  PermissionOverrideInput,
  PermissionSource,
} from '@qa-flow-hub/shared';
import { Badge, Button, DataState } from '@qa-flow-hub/ui';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { permissionsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { humanize } from './status';
import { t } from '../i18n/i18n';

type Choice = 'default' | PermissionEffectName;

const SOURCE_TONE: Record<PermissionSource, BadgeTone> = {
  owner: 'success',
  role: 'neutral',
  override: 'info',
};

const SOURCE_LABEL: Record<PermissionSource, string> = {
  owner: 'ownership',
  role: 'role',
  override: 'override',
};

function toChoices(view: MemberPermissionsView): Map<Permission, Choice> {
  return new Map(view.overrides.map((override) => [override.permission, override.effect]));
}

function toOverrides(choices: Map<Permission, Choice>): PermissionOverrideInput[] {
  const overrides: PermissionOverrideInput[] = [];
  for (const [permission, choice] of choices) {
    if (choice !== 'default') {
      overrides.push({ permission, effect: choice });
    }
  }
  return overrides;
}

/**
 * Effective permissions of one member in one project, grouped by module.
 *
 * Each row answers three questions at once — is it held, why, and can *I*
 * change that — because a flat list of checkboxes answers only the first and
 * makes the second impossible to tell. The choice column exists only for
 * somebody who may edit overrides; everybody else gets the explanation alone.
 * Whatever the screen offers, the API re-checks: hidden controls are a
 * courtesy, not a boundary.
 */
export function MemberPermissionsPanel({
  projectId,
  userId,
  email,
  canEdit,
  actorPermissions,
}: {
  projectId: string;
  userId: string;
  email: string;
  /** Whether the actor holds `members.manage` here and this is not themselves. */
  canEdit: boolean;
  /** What the actor holds effectively: they can only grant from within it. */
  actorPermissions: ReadonlySet<Permission>;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [choices, setChoices] = useState<Map<Permission, Choice>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const view = useQuery({
    queryKey: ['member-permissions', projectId, userId],
    queryFn: () => permissionsApi.forMember(projectId, userId),
  });

  useEffect(() => {
    if (view.data !== undefined) {
      setChoices(toChoices(view.data));
    }
  }, [view.data]);

  const save = useMutation({
    mutationFn: (overrides: PermissionOverrideInput[]) =>
      permissionsApi.replace(projectId, userId, { overrides }),
    onSuccess: async (next) => {
      setError(null);
      setSaved(true);
      queryClient.setQueryData(['member-permissions', projectId, userId], next);
      await queryClient.invalidateQueries({ queryKey: ['project-permission-overrides'] });
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiError
          ? cause.message
          : t('c_memberPermissionsPanel.couldNotSaveTheOverrides'),
      );
    },
  });

  if (view.data === undefined) {
    return (
      <DataState isPending={view.isPending} error={view.error}>
        <span className="muted">{t('c_memberPermissionsPanel.loadingPermissions')}</span>
      </DataState>
    );
  }

  const data = view.data;
  const isOwner = data.effectiveRole === 'organization_owner';
  const preview = computeEffectivePermissions(data.effectiveRole, toOverrides(choices));
  const dirty =
    JSON.stringify(toOverrides(choices)) !== JSON.stringify(toOverrides(toChoices(data)));
  const editable = canEdit && !isOwner;

  return (
    <section
      className="permissions"
      aria-label={t('c_memberPermissionsPanel.permissionsOfInThisProject', { email })}
    >
      <dl className="details">
        <dt>{t('c_memberPermissionsPanel.organizationRole')}</dt>
        <dd>{humanize(data.organizationRole)}</dd>
        <dt>{t('c_memberPermissionsPanel.projectRole')}</dt>
        <dd>
          {data.projectRole === null ? (
            <span className="muted">{t('c_memberPermissionsPanel.inherited')}</span>
          ) : (
            humanize(data.projectRole)
          )}
        </dd>
        <dt>{t('c_memberPermissionsPanel.enforcedRole')}</dt>
        <dd>{humanize(data.effectiveRole)}</dd>
        <dt>{t('c_memberPermissionsPanel.overrides')}</dt>
        <dd>
          {data.overrides.length === 0 ? (
            <span className="muted">
              {t('c_memberPermissionsPanel.noneTheRoleDecidesEverything')}
            </span>
          ) : (
            t('c_memberPermissionsPanel.inThisProject', { length: data.overrides.length })
          )}
        </dd>
      </dl>

      {isOwner && (
        <p className="callout">{t('c_memberPermissionsPanel.anOrganizationOwnerHoldsEvery')}</p>
      )}

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      {saved && !dirty && (
        <p className="muted" role="status">
          {t('c_memberPermissionsPanel.overridesSavedTheApiApplies')}
        </p>
      )}

      <div className="permissions__modules">
        {PERMISSION_MODULES.map((module) => {
          const rows = preview.filter((entry) => entry.module === module);
          if (rows.length === 0) {
            return null;
          }
          return (
            <table className="table permissions__module" key={module}>
              <caption>{PERMISSION_MODULE_LABELS[module]}</caption>
              <thead className="visually-hidden">
                <tr>
                  <th scope="col">{t('c_memberPermissionsPanel.permission')}</th>
                  <th scope="col">{t('c_memberPermissionsPanel.held')}</th>
                  <th scope="col">{t('c_memberPermissionsPanel.source')}</th>
                  {editable && <th scope="col">{t('c_memberPermissionsPanel.override')}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => {
                  const descriptor = PERMISSION_CATALOG.find(
                    (candidate) => candidate.permission === entry.permission,
                  );
                  const choice = choices.get(entry.permission) ?? 'default';
                  const mayGrant = actorPermissions.has(entry.permission);
                  return (
                    <tr key={entry.permission} data-permission={entry.permission}>
                      <td>
                        <span title={descriptor?.description}>
                          {descriptor?.label ?? entry.permission}
                        </span>
                        <div className="muted">
                          <code>{entry.permission}</code>
                        </div>
                      </td>
                      <td>
                        <Badge tone={entry.granted ? 'success' : 'neutral'}>
                          {entry.granted
                            ? t('c_memberPermissionsPanel.allowed')
                            : t('c_memberPermissionsPanel.notAllowed')}
                        </Badge>
                      </td>
                      <td>
                        <Badge tone={SOURCE_TONE[entry.source]}>{SOURCE_LABEL[entry.source]}</Badge>
                      </td>
                      {editable && (
                        <td>
                          <select
                            className="ui-input"
                            aria-label={t('c_memberPermissionsPanel.overrideFor', {
                              permission: entry.permission,
                              email,
                            })}
                            value={choice}
                            onChange={(event) => {
                              const next = new Map(choices);
                              next.set(entry.permission, event.target.value as Choice);
                              setChoices(next);
                              setSaved(false);
                            }}
                          >
                            <option value="default">
                              {t('c_memberPermissionsPanel.roleDefault')}
                            </option>
                            <option value="grant" disabled={!mayGrant}>
                              {t('c_memberPermissionsPanel.grant')}
                              {mayGrant ? '' : t('c_memberPermissionsPanel.youDoNotHoldIt')}
                            </option>
                            <option value="revoke">{t('c_memberPermissionsPanel.revoke')}</option>
                          </select>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          );
        })}
      </div>

      {editable && (
        <div className="row-actions">
          <Button
            onClick={() => {
              save.mutate(toOverrides(choices));
            }}
            disabled={!dirty || save.isPending}
          >
            {save.isPending
              ? t('c_memberPermissionsPanel.saving')
              : t('c_memberPermissionsPanel.saveOverrides')}
          </Button>
          <Button
            variant="ghost"
            disabled={!dirty}
            onClick={() => {
              setChoices(toChoices(data));
            }}
          >
            {t('c_memberPermissionsPanel.discard')}
          </Button>
        </div>
      )}
    </section>
  );
}
