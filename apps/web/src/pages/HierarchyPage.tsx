import { WORK_ITEM_STATUSES, WORK_ITEM_TYPES, canBeParentOf } from '@qa-flow-hub/shared';
import type {
  WorkItemRollup,
  WorkItemStatus,
  WorkItemTreeNode,
  WorkItemType,
  WorkItemView,
} from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { workItemsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { WORK_ITEM_TONE } from './WorkItemsPage';

/** "2/3 done (66.7%) · 8 estimated", or nothing for a leaf. */
export function rollupText(rollup: WorkItemRollup): string {
  if (rollup.count === 0) {
    return '';
  }
  const countable = rollup.count - rollup.byStatus.cancelled;
  const progress = rollup.progress === null ? '' : ` (${rollup.progress}%)`;
  return `${rollup.byStatus.done}/${countable} done${progress} · ${rollup.estimate} estimated`;
}

/** Every item of the tree, flattened, for the "move under" choices. */
function flatten(nodes: readonly WorkItemTreeNode[]): WorkItemView[] {
  return nodes.flatMap((node) => [node.item, ...flatten(node.children)]);
}

/** Ids of an item and all of its descendants: never valid new parents. */
function subtreeIds(node: WorkItemTreeNode): Set<string> {
  return new Set([node.item.id, ...node.children.flatMap((child) => [...subtreeIds(child)])]);
}

export function HierarchyPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(activeProjectId);
  const [type, setType] = useState<WorkItemType | ''>('');
  const [status, setStatus] = useState<WorkItemStatus | ''>('');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const projectId = activeProjectId ?? '';
  const trimmed = search.trim();
  const editable = can('work_items.write');

  const tree = useQuery({
    queryKey: ['work-items', 'tree', activeProjectId, type, status, trimmed],
    queryFn: () =>
      workItemsApi.tree({
        projectId,
        ...(type === '' ? {} : { type }),
        ...(status === '' ? {} : { status }),
        ...(trimmed === '' ? {} : { search: trimmed }),
      }),
    enabled: activeProjectId !== null,
  });

  const reparent = useMutation({
    mutationFn: (input: { id: string; parentId: string | null }) =>
      workItemsApi.reparent(input.id, { parentId: input.parentId }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['work-items'] });
      await queryClient.invalidateQueries({ queryKey: ['backlog'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not move the work item.');
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  const roots = tree.data?.roots ?? [];
  const everything = flatten(roots);
  const allParents = roots.flatMap(function parents(node): string[] {
    return node.children.length === 0 ? [] : [node.item.id, ...node.children.flatMap(parents)];
  });

  const toggle = (id: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const renderNode = (node: WorkItemTreeNode, depth: number): React.JSX.Element => {
    const { item } = node;
    const open = !collapsed.has(item.id);
    const excluded = subtreeIds(node);
    const parents = everything.filter(
      (candidate) => !excluded.has(candidate.id) && canBeParentOf(candidate.type, item.type),
    );
    return (
      <li
        key={item.id}
        data-testid={`tree-node-${item.key}`}
        className={node.matched ? undefined : 'muted'}
      >
        <div className="tree-row" style={{ paddingLeft: `${(depth - 1) * 1.5}rem` }}>
          {node.children.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} ${item.key}`}
              onClick={() => {
                toggle(item.id);
              }}
            >
              {open ? '▾' : '▸'}
            </Button>
          ) : (
            <span aria-hidden="true">·</span>
          )}{' '}
          <code>{item.key}</code> <Link to={`/work-items/${item.id}`}>{item.title}</Link>{' '}
          <span className="muted">{humanize(item.type)}</span>{' '}
          <Badge tone={WORK_ITEM_TONE[item.status]}>{humanize(item.status)}</Badge>{' '}
          <span className="muted" data-testid={`rollup-${item.key}`}>
            {rollupText(node.rollup)}
          </span>
          {editable && (
            <select
              className="ui-input ui-select"
              aria-label={`Move ${item.key} under`}
              value={item.parentId ?? ''}
              disabled={reparent.isPending}
              onChange={(event) => {
                reparent.mutate({
                  id: item.id,
                  parentId: event.target.value === '' ? null : event.target.value,
                });
              }}
            >
              <option value="">Top level</option>
              {parents.map((parent) => (
                <option key={parent.id} value={parent.id}>
                  {parent.key} {parent.title}
                </option>
              ))}
            </select>
          )}
        </div>
        {open && node.children.length > 0 && (
          <ul className="tree" role="group">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <>
      <PageHeader
        title="Hierarchy"
        description="Epics, features, stories and tasks as a tree, with the progress and estimates of everything below each item."
      />
      <section className="card filters" aria-label="Hierarchy filters">
        <SelectField
          label="Type filter"
          value={type}
          options={[
            { value: '', label: 'Any type' },
            ...WORK_ITEM_TYPES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setType(event.target.value as WorkItemType | '');
          }}
        />
        <SelectField
          label="Status filter"
          value={status}
          options={[
            { value: '', label: 'Any status' },
            ...WORK_ITEM_STATUSES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setStatus(event.target.value as WorkItemStatus | '');
          }}
        />
        <TextField
          label="Search tree"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        <div className="row-actions">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setCollapsed(new Set());
            }}
          >
            Expand all
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setCollapsed(new Set(allParents));
            }}
          >
            Collapse all
          </Button>
        </div>
      </section>
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      {tree.data !== undefined && (
        <p className="muted" data-testid="tree-totals">
          {tree.data.totals.count} items · {tree.data.totals.byStatus.done} done ·{' '}
          {tree.data.totals.estimate} estimated
          {tree.data.truncated && ' · showing the first 2000'}
        </p>
      )}
      <DataState
        isPending={tree.isPending}
        error={tree.error}
        isEmpty={roots.length === 0}
        emptyMessage="No work item matches."
      >
        <ul className="tree card" role="tree" aria-label="Work item hierarchy">
          {roots.map((node) => renderNode(node, 1))}
        </ul>
      </DataState>
    </>
  );
}
