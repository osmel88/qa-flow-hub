import { z } from 'zod';

/**
 * What the client sees of the Jira integration once it is connected (S2-F2).
 *
 * Everything here is expressed in qa-flow-hub's terms plus the fields any issue
 * tracker has — key, status, priority, assignee. The mock behind it is a Jira
 * mock, but nothing in these contracts would change for a real Jira, which is
 * the test that they are provider-shaped rather than mock-shaped.
 */

export const JIRA_SYNCABLE_ENTITIES = ['requirement', 'defect'] as const;
export type JiraSyncableEntity = (typeof JIRA_SYNCABLE_ENTITIES)[number];
export const jiraSyncableEntitySchema = z.enum(JIRA_SYNCABLE_ENTITIES);

export const ISSUE_KINDS = ['story', 'task', 'bug'] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

/** Every entity a mock provider can hold a reference for; Jira and TestRail each take a subset. */
export const SYNCABLE_ENTITIES = [
  'requirement',
  'defect',
  'test_suite',
  'test_case',
  'test_run',
  'test_result',
] as const;
export type SyncableEntity = (typeof SYNCABLE_ENTITIES)[number];

export type SyncProvider = 'jira' | 'testrail' | 'github';

export interface ExternalReferenceView {
  id: string;
  provider: SyncProvider;
  entityType: SyncableEntity;
  entityId: string;
  externalId: string;
  externalKey: string | null;
  externalUrl: string | null;
  metadata: Record<string, string>;
  connectionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalProjectView {
  externalId: string;
  key: string;
  name: string;
}

export interface ExternalAssigneeView {
  externalId: string;
  displayName: string;
}

export interface ExternalIssueView {
  externalId: string;
  key: string | null;
  url: string | null;
  projectKey: string | null;
  kind: IssueKind;
  title: string;
  status: string;
  priority: string;
  assignee: ExternalAssigneeView | null;
  labels: string[];
  updatedAt: string;
}

export interface IssueTrackerCatalogView {
  priorities: string[];
  statuses: string[];
  assignees: ExternalAssigneeView[];
}

export const listExternalIssuesQuerySchema = z.object({
  projectKey: z.string().trim().min(1).max(32).optional(),
  kind: z.enum(ISSUE_KINDS).optional(),
});
export type ListExternalIssuesQuery = z.infer<typeof listExternalIssuesQuerySchema>;

export const listExternalReferencesQuerySchema = z.object({
  projectId: z.string().min(1),
  entityType: jiraSyncableEntitySchema,
});
export type ListExternalReferencesQuery = z.infer<typeof listExternalReferencesQuerySchema>;

export type JiraSyncAction = 'created' | 'updated';

export interface JiraSyncResultView {
  entityType: JiraSyncableEntity;
  entityId: string;
  action: JiraSyncAction;
  reference: ExternalReferenceView;
  issue: ExternalIssueView;
}
