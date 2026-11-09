import type {
  RestoreVersionInput,
  TestCaseVersionSummaryView,
  TestCaseVersionView,
  VersionDiffView,
  ImportDatasetInput,
  ReplaceParametersInput,
  CreateTestCycleInput,
  TestCycleProgressView,
  TestCycleView,
  UpdateTestCycleInput,
  CreateTestPlanInput,
  ListTestPlansQuery,
  TestPlanProgressView,
  TestPlanView,
  UpdateTestPlanInput,
  CreateDeploymentInput,
  CreateDeploymentResult,
  CreateEnvironmentInput,
  DeploymentMetricsView,
  DeploymentView,
  EnvironmentView,
  CreateQualityGateInput,
  ApprovalRuleView,
  CreateApprovalRuleInput,
  DecideApprovalInput,
  ReleaseApprovalsView,
  UpdateApprovalRuleInput,
  QualityGateView,
  ReleaseQualityGatesView,
  UpdateQualityGateInput,
  ReleasePipelineQuery,
  ReleasePipelineView,
  ListEnvironmentsQuery,
  UpdateEnvironmentInput,
  ListDeploymentsQuery,
  RollbackDeploymentInput,
  RollbackEnvironmentInput,
  EnvironmentRollbackResult,
  TransitionDeploymentInput,
  BuildMetricsView,
  BuildView,
  CreateBuildInput,
  CreateBuildResult,
  ListBuildsQuery,
  TransitionBuildInput,
  UpdateBuildInput,
  CodeReviewDecisionInput,
  CodeReviewSettingsView,
  CodeReviewSummaryView,
  CodeReviewView,
  CreateCodeReviewInput,
  ListCodeReviewsQuery,
  CreateDevelopmentArtifactInput,
  DevelopmentArtifactView,
  DevelopmentLinkResult,
  DevelopmentSummaryView,
  ListDevelopmentArtifactsQuery,
  UpdateDevelopmentArtifactInput,
  WorkItemDevelopmentView,
  KanbanQuery,
  KanbanView,
  MoveKanbanCardInput,
  UpdateWipLimitsInput,
  BoardQuery,
  BoardView,
  MoveBoardCardInput,
  CloseSprintInput,
  CloseSprintResult,
  CreateSprintInput,
  ListSprintsQuery,
  SprintDetailView,
  SprintListView,
  SprintView,
  UpdateSprintInput,
  ReparentWorkItemInput,
  WorkItemTreeQuery,
  WorkItemTreeView,
  BacklogQuery,
  BacklogView,
  BulkUpdateWorkItemsInput,
  BulkUpdateWorkItemsResult,
  MoveWorkItemInput,
  CreateWorkItemInput,
  ListWorkItemsQuery,
  UpdateWorkItemInput,
  WorkItemDetailView,
  WorkItemView,
  CreateCustomFieldInput,
  CustomFieldEntity,
  CustomFieldView,
  DefectWorkflowView,
  UpdateCustomFieldInput,
  UpdateDefectWorkflowInput,
  CreateReleaseInput,
  ListReleasesQuery,
  ReleaseSummaryView,
  ReleaseTraceabilityView,
  ReleaseView,
  UpdateReleaseInput,
  ApiKeyView,
  CreateApiKeyInput,
  CreatedApiKeyView,
  IngestionReportView,
  AttachableEntity,
  AttachmentLimitsView,
  AttachmentView,
  AuthSession,
  MfaChallengeView,
  MfaRecoveryCodesView,
  MfaSetupView,
  MfaStatusView,
  MfaVerifyInput,
  OrganizationView,
  UpdateOrganizationInput,
  BillingOverviewView,
  ChangePlanInput,
  CheckoutSessionView,
  CompleteMockCheckoutInput,
  InvoiceView,
  MockCheckoutSessionView,
  PaidPlanName,
  ChangePasswordInput,
  ConfigurableIntegrationProvider,
  CreateDefectInput,
  CreateInvitationInput,
  CreateOrganizationInput,
  CreateProjectInput,
  CreateRequirementInput,
  CreateSectionInput,
  CreateSuiteInput,
  CreateTestCaseInput,
  CreateTestRunInput,
  CreateTraceLinkInput,
  CreatedInvitationView,
  DashboardSummary,
  OrganizationDashboard,
  ProjectCoverageView,
  ProjectDashboardSummary,
  ProjectDefectsView,
  ProjectTestResultsView,
  ProjectTrendsView,
  DefectView,
  EmailProviderView,
  ListNotificationsQuery,
  MemberPermissionsView,
  MockEmailPreview,
  PermissionDescriptor,
  PermissionOverrideView,
  ROLE_PERMISSIONS,
  SetPermissionOverridesInput,
  NotificationPreferencesView,
  NotificationView,
  UpdateNotificationPreferencesInput,
  ExternalIssueView,
  ExternalProjectView,
  ExternalReferenceView,
  ExternalTraceabilityQuery,
  ExternalTraceabilityVerificationView,
  ExternalTraceabilityView,
  ExternalRepositoryView,
  ExternalWorkflowRunView,
  GitHubSyncResultView,
  ImportAutomatedResultsView,
  LinkWorkflowRunInput,
  ListGitHubReferencesQuery,
  ListWorkflowRunsQuery,
  IntegrationConnectionView,
  IntegrationTestResultView,
  InvitationView,
  JiraSyncResultView,
  JiraSyncableEntity,
  LoginInput,
  MemberView,
  OrganizationRoleName,
  OrganizationSummary,
  Paginated,
  ProjectMemberView,
  ProjectView,
  RegisterInput,
  RecordResultInput,
  RequirementLinkResult,
  RequirementView,
  RequirementWorkItemsView,
  RunCaseView,
  SectionView,
  SuiteView,
  TestCaseDetailView,
  TestCaseView,
  TestResultView,
  ListTestRailReferencesQuery,
  TestRailSyncableEntity,
  TestRailSyncResultView,
  TestRunView,
  TraceLinkView,
  TraceabilityMatrix,
  UpdateDefectInput,
  UpdateTestCaseInput,
  UpsertIntegrationInput,
  CreateImportQuery,
  ImportCommitResult,
  ImportJobView,
  ImportLimitsView,
} from '@qa-flow-hub/shared';
import { apiFetch, apiFetchBlob, query } from './http-client';

/**
 * Every call the client can make, in one place.
 *
 * Grouped by resource rather than split per file: the surface is small enough
 * that one module is easier to search than nine, and it makes the whole API
 * contract visible at a glance when a screen needs something new.
 */

export const authApi = {
  register: (body: RegisterInput) =>
    apiFetch<AuthSession>('/auth/register', {
      method: 'POST',
      body,
      withoutOrganization: true,
      skipRefresh: true,
    }),
  /** With MFA enabled the password alone yields a challenge, not a session. */
  login: (body: LoginInput) =>
    apiFetch<AuthSession | MfaChallengeView>('/auth/login', {
      method: 'POST',
      body,
      withoutOrganization: true,
      skipRefresh: true,
    }),
  /** The refresh cookie is the credential; the client has nothing to send. */
  logout: () =>
    apiFetch<void>('/auth/logout', {
      method: 'POST',
      body: {},
      withoutOrganization: true,
      skipRefresh: true,
    }),
  me: () =>
    apiFetch<AuthSession['user'] & { organizations: OrganizationSummary[] }>('/auth/me', {
      withoutOrganization: true,
    }),
  changePassword: (body: ChangePasswordInput) =>
    apiFetch<void>('/auth/change-password', { method: 'POST', body, withoutOrganization: true }),
};

export const mfaApi = {
  verify: (body: MfaVerifyInput) =>
    apiFetch<AuthSession>('/auth/mfa/verify', {
      method: 'POST',
      body,
      withoutOrganization: true,
      skipRefresh: true,
    }),
  status: () => apiFetch<MfaStatusView>('/auth/mfa', { withoutOrganization: true }),
  setup: (password: string) =>
    apiFetch<MfaSetupView>('/auth/mfa/setup', {
      method: 'POST',
      body: { password },
      withoutOrganization: true,
    }),
  confirm: (code: string) =>
    apiFetch<MfaRecoveryCodesView>('/auth/mfa/confirm', {
      method: 'POST',
      body: { code },
      withoutOrganization: true,
    }),
  disable: (password: string, code: string) =>
    apiFetch<void>('/auth/mfa/disable', {
      method: 'POST',
      body: { password, code },
      withoutOrganization: true,
    }),
  regenerateRecoveryCodes: (code: string) =>
    apiFetch<MfaRecoveryCodesView>('/auth/mfa/recovery-codes', {
      method: 'POST',
      body: { code },
      withoutOrganization: true,
    }),
};

export const organizationsApi = {
  update: (body: UpdateOrganizationInput) =>
    apiFetch<OrganizationView>('/organizations/current', { method: 'PATCH', body }),
  list: () => apiFetch<OrganizationSummary[]>('/organizations', { withoutOrganization: true }),
  create: (body: CreateOrganizationInput) =>
    apiFetch<OrganizationSummary>('/organizations', {
      method: 'POST',
      body,
      withoutOrganization: true,
    }),
  members: () => apiFetch<Paginated<MemberView>>('/organizations/current/members'),
  updateMember: (userId: string, role: string) =>
    apiFetch<MemberView>(`/organizations/current/members/${userId}`, {
      method: 'PATCH',
      body: { role },
    }),
  removeMember: (userId: string) =>
    apiFetch<void>(`/organizations/current/members/${userId}`, { method: 'DELETE' }),
  invitations: () => apiFetch<InvitationView[]>('/organizations/current/invitations'),
  invite: (body: CreateInvitationInput) =>
    apiFetch<CreatedInvitationView>('/organizations/current/invitations', {
      method: 'POST',
      body,
    }),
  revokeInvitation: (id: string) =>
    apiFetch<void>(`/organizations/current/invitations/${id}`, { method: 'DELETE' }),
  acceptInvitation: (token: string) =>
    apiFetch<{ organizationId: string; organizationName: string; role: OrganizationRoleName }>(
      '/organizations/invitations/accept',
      {
        method: 'POST',
        body: { token },
        withoutOrganization: true,
      },
    ),
};

export const projectsApi = {
  list: (params: { status?: string; search?: string } = {}) =>
    apiFetch<Paginated<ProjectView>>(`/projects${query({ ...params, pageSize: 100 })}`),
  create: (body: CreateProjectInput) =>
    apiFetch<ProjectView>('/projects', { method: 'POST', body }),
  archive: (id: string) => apiFetch<ProjectView>(`/projects/${id}/archive`, { method: 'POST' }),
  restore: (id: string) => apiFetch<ProjectView>(`/projects/${id}/restore`, { method: 'POST' }),
  members: (projectId: string) =>
    apiFetch<Paginated<ProjectMemberView>>(
      `/projects/${projectId}/members${query({ pageSize: 100 })}`,
    ),
  grantRole: (projectId: string, userId: string, role: string | null) =>
    apiFetch<ProjectMemberView>(`/projects/${projectId}/members`, {
      method: 'POST',
      body: { userId, role },
    }),
  revokeRole: (projectId: string, userId: string) =>
    apiFetch<void>(`/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),
};

export const permissionsApi = {
  catalog: () =>
    apiFetch<{ permissions: PermissionDescriptor[]; roles: typeof ROLE_PERMISSIONS }>(
      '/permissions/catalog',
    ),
  mine: (projectId: string) =>
    apiFetch<MemberPermissionsView>(`/projects/${projectId}/permissions/me`),
  forMember: (projectId: string, userId: string) =>
    apiFetch<MemberPermissionsView>(`/projects/${projectId}/permissions/members/${userId}`),
  overrides: (projectId: string) =>
    apiFetch<PermissionOverrideView[]>(`/projects/${projectId}/permissions/overrides`),
  replace: (projectId: string, userId: string, body: SetPermissionOverridesInput) =>
    apiFetch<MemberPermissionsView>(`/projects/${projectId}/permissions/members/${userId}`, {
      method: 'PUT',
      body,
    }),
};

/**
 * Walks every page of a collection. For pickers that must offer the whole
 * set: a select fed by page one silently hides everything after it.
 */
export async function allPages<T>(
  fetchPage: (page: number) => Promise<Paginated<T>>,
): Promise<T[]> {
  const first = await fetchPage(1);
  const items = [...first.data];
  for (let page = 2; page <= first.meta.totalPages; page += 1) {
    items.push(...(await fetchPage(page)).data);
  }
  return items;
}

export const requirementsApi = {
  list: (params: {
    projectId: string;
    status?: string;
    priority?: string;
    search?: string;
    implementation?: string;
  }) => apiFetch<Paginated<RequirementView>>(`/requirements${query({ ...params, pageSize: 100 })}`),
  get: (id: string) => apiFetch<RequirementView>(`/requirements/${id}`),
  workItems: (id: string) => apiFetch<RequirementWorkItemsView>(`/requirements/${id}/work-items`),
  linkWorkItem: (id: string, workItemId: string) =>
    apiFetch<RequirementLinkResult>(`/requirements/${id}/work-items`, {
      method: 'POST',
      body: { workItemId },
    }),
  unlinkWorkItem: (id: string, workItemId: string) =>
    apiFetch<void>(`/requirements/${id}/work-items/${workItemId}`, { method: 'DELETE' }),
  listAll: (params: { projectId: string }) =>
    allPages((page) =>
      apiFetch<Paginated<RequirementView>>(
        `/requirements${query({ ...params, page, pageSize: 100 })}`,
      ),
    ),
  create: (body: CreateRequirementInput) =>
    apiFetch<RequirementView>('/requirements', { method: 'POST', body }),
  changeStatus: (id: string, status: string) =>
    apiFetch<RequirementView>(`/requirements/${id}/status`, { method: 'POST', body: { status } }),
};

export const testDesignApi = {
  suites: (projectId: string) => apiFetch<SuiteView[]>(`/test-suites${query({ projectId })}`),
  createSuite: (body: CreateSuiteInput) =>
    apiFetch<SuiteView>('/test-suites', { method: 'POST', body }),
  sections: (suiteId: string) => apiFetch<SectionView[]>(`/test-suites/${suiteId}/sections`),
  createSection: (body: CreateSectionInput) =>
    apiFetch<SectionView>('/test-sections', { method: 'POST', body }),
  cases: (params: {
    projectId: string;
    suiteId?: string;
    search?: string;
    includeArchived?: 'true' | 'false';
  }) => apiFetch<Paginated<TestCaseView>>(`/test-cases${query({ ...params, pageSize: 100 })}`),
  allCases: (params: { projectId: string }) =>
    allPages((page) =>
      apiFetch<Paginated<TestCaseView>>(`/test-cases${query({ ...params, page, pageSize: 100 })}`),
    ),
  case: (id: string) => apiFetch<TestCaseDetailView>(`/test-cases/${id}`),
  createCase: (body: CreateTestCaseInput) =>
    apiFetch<TestCaseDetailView>('/test-cases', { method: 'POST', body }),
  updateCase: (id: string, body: UpdateTestCaseInput) =>
    apiFetch<TestCaseDetailView>(`/test-cases/${id}`, { method: 'PATCH', body }),
  replaceSteps: (id: string, steps: Array<{ action: string; expectedResult?: string | null }>) =>
    apiFetch<TestCaseDetailView>(`/test-cases/${id}/steps`, { method: 'POST', body: { steps } }),
  duplicate: (id: string) =>
    apiFetch<TestCaseDetailView>(`/test-cases/${id}/duplicate`, { method: 'POST', body: {} }),
  archive: (id: string) => apiFetch<TestCaseView>(`/test-cases/${id}/archive`, { method: 'POST' }),
  restore: (id: string) => apiFetch<TestCaseView>(`/test-cases/${id}/restore`, { method: 'POST' }),
  replaceParameters: (id: string, body: ReplaceParametersInput) =>
    apiFetch<TestCaseDetailView>(`/test-cases/${id}/parameters`, { method: 'PUT', body }),
  importDataset: (id: string, body: ImportDatasetInput) =>
    apiFetch<TestCaseDetailView>(`/test-cases/${id}/dataset/import`, { method: 'POST', body }),
  exportDataset: (id: string) => apiFetchBlob(`/test-cases/${id}/dataset/export.csv`),
  versions: (id: string) => apiFetch<TestCaseVersionSummaryView[]>(`/test-cases/${id}/versions`),
  version: (id: string, version: number) =>
    apiFetch<TestCaseVersionView>(`/test-cases/${id}/versions/${version}`),
  diffVersions: (id: string, from: number, to: number) =>
    apiFetch<VersionDiffView>(`/test-cases/${id}/versions/diff${query({ from, to })}`),
  restoreVersion: (id: string, version: number, body: RestoreVersionInput) =>
    apiFetch<TestCaseDetailView>(`/test-cases/${id}/versions/${version}/restore`, {
      method: 'POST',
      body,
    }),
};

export const testRunsApi = {
  list: (params: { projectId: string; status?: string; releaseId?: string }) =>
    apiFetch<Paginated<TestRunView>>(`/test-runs${query({ ...params, pageSize: 100 })}`),
  get: (id: string) => apiFetch<TestRunView>(`/test-runs/${id}`),
  create: (body: CreateTestRunInput) =>
    apiFetch<TestRunView>('/test-runs', { method: 'POST', body }),
  cases: (id: string) =>
    apiFetch<Paginated<RunCaseView>>(`/test-runs/${id}/cases${query({ pageSize: 100 })}`),
  start: (id: string) => apiFetch<TestRunView>(`/test-runs/${id}/start`, { method: 'POST' }),
  complete: (id: string) => apiFetch<TestRunView>(`/test-runs/${id}/complete`, { method: 'POST' }),
  recordResult: (runId: string, runCaseId: string, body: RecordResultInput) =>
    apiFetch<TestResultView>(`/test-runs/${runId}/cases/${runCaseId}/results`, {
      method: 'POST',
      body,
    }),
  results: (runId: string, runCaseId: string) =>
    apiFetch<TestResultView[]>(`/test-runs/${runId}/cases/${runCaseId}/results`),
};

export const defectsApi = {
  list: (params: { projectId: string; status?: string; severity?: string; open?: string }) =>
    apiFetch<Paginated<DefectView>>(`/defects${query({ ...params, pageSize: 100 })}`),
  create: (body: CreateDefectInput) => apiFetch<DefectView>('/defects', { method: 'POST', body }),
  update: (id: string, body: UpdateDefectInput) =>
    apiFetch<DefectView>(`/defects/${id}`, { method: 'PATCH', body }),
  changeStatus: (id: string, status: string) =>
    apiFetch<DefectView>(`/defects/${id}/status`, { method: 'POST', body: { status } }),
};

export const traceabilityApi = {
  matrix: (projectId: string, uncoveredOnly = false) =>
    apiFetch<TraceabilityMatrix>(
      `/traceability/matrix${query({ projectId, uncoveredOnly: String(uncoveredOnly) })}`,
    ),
  link: (body: CreateTraceLinkInput) =>
    apiFetch<TraceLinkView>('/traceability/links', { method: 'POST', body }),
  links: (entityType: 'requirement' | 'test_case', entityId: string) =>
    apiFetch<TraceLinkView[]>(`/traceability/links${query({ entityType, entityId })}`),
  unlink: (id: string) => apiFetch<void>(`/traceability/links/${id}`, { method: 'DELETE' }),
};

export const integrationsApi = {
  list: () => apiFetch<IntegrationConnectionView[]>('/integrations'),
  save: (provider: ConfigurableIntegrationProvider, body: UpsertIntegrationInput) =>
    apiFetch<IntegrationConnectionView>(`/integrations/${provider}`, { method: 'PUT', body }),
  connect: (provider: ConfigurableIntegrationProvider) =>
    apiFetch<IntegrationConnectionView>(`/integrations/${provider}/connect`, { method: 'POST' }),
  disconnect: (provider: ConfigurableIntegrationProvider) =>
    apiFetch<IntegrationConnectionView>(`/integrations/${provider}/disconnect`, { method: 'POST' }),
  testConnection: (provider: ConfigurableIntegrationProvider) =>
    apiFetch<IntegrationTestResultView>(`/integrations/${provider}/test-connection`, {
      method: 'POST',
    }),
};

export const notificationsApi = {
  preferences: () => apiFetch<NotificationPreferencesView>('/notifications/preferences'),
  updatePreferences: (body: UpdateNotificationPreferencesInput) =>
    apiFetch<NotificationPreferencesView>('/notifications/preferences', { method: 'PATCH', body }),
  provider: () => apiFetch<EmailProviderView>('/notifications/provider'),
  list: (params: Partial<ListNotificationsQuery>) =>
    apiFetch<Paginated<NotificationView>>(`/notifications${query(params)}`),
  outbox: (params: Partial<ListNotificationsQuery>) =>
    apiFetch<Paginated<MockEmailPreview>>(`/notifications/outbox${query(params)}`),
  retry: (id: string) =>
    apiFetch<NotificationView>(`/notifications/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    }),
};

export const attachmentsApi = {
  limits: () => apiFetch<AttachmentLimitsView>('/attachments/limits'),
  list: (entityType: AttachableEntity, entityId: string) =>
    apiFetch<{ data: AttachmentView[] }>(`/attachments${query({ entityType, entityId })}`),
  upload: (entityType: AttachableEntity, entityId: string, file: File) => {
    const body = new FormData();
    body.append('file', file, file.name);
    return apiFetch<AttachmentView>(`/attachments${query({ entityType, entityId })}`, {
      method: 'POST',
      body,
    });
  },
  /** Bytes through the API, never a storage path: the token travels with them. */
  download: (id: string, disposition: 'inline' | 'attachment' = 'attachment') =>
    apiFetchBlob(`/attachments/${id}/content${query({ disposition })}`),
  remove: (id: string) => apiFetch<void>(`/attachments/${id}`, { method: 'DELETE' }),
};

export const billingApi = {
  overview: () => apiFetch<BillingOverviewView>('/billing'),
  invoices: (page: number) =>
    apiFetch<Paginated<InvoiceView>>(`/billing/invoices${query({ page, pageSize: 10 })}`),
  checkout: (plan: PaidPlanName) =>
    apiFetch<CheckoutSessionView>('/billing/checkout', { method: 'POST', body: { plan } }),
  changePlan: (body: ChangePlanInput) =>
    apiFetch<BillingOverviewView>('/billing/plan', { method: 'POST', body }),
  cancel: () => apiFetch<BillingOverviewView>('/billing/cancel', { method: 'POST' }),
  resume: () => apiFetch<BillingOverviewView>('/billing/resume', { method: 'POST' }),
  mockSession: (sessionId: string) =>
    apiFetch<MockCheckoutSessionView>(`/billing/mock/checkout/${sessionId}`),
  completeMockCheckout: (sessionId: string, body: CompleteMockCheckoutInput) =>
    apiFetch<BillingOverviewView>(`/billing/mock/checkout/${sessionId}/complete`, {
      method: 'POST',
      body,
    }),
  endMockPeriod: (outcome: 'succeeded' | 'failed') =>
    apiFetch<BillingOverviewView>('/billing/mock/end-period', {
      method: 'POST',
      body: { outcome },
    }),
};

export const dashboardApi = {
  summary: (projectId?: string) => apiFetch<DashboardSummary>(`/dashboard${query({ projectId })}`),
};

/** An explicit `[from, to)` window, ISO-8601; the API picks the bucket. */
export interface AnalyticsWindow {
  from: string;
  to: string;
}

const projectDashboard = <T>(projectId: string, part: string, window: AnalyticsWindow) =>
  apiFetch<T>(`/projects/${projectId}/dashboard/${part}${query({ ...window })}`);

export const analyticsApi = {
  summary: (projectId: string, window: AnalyticsWindow) =>
    projectDashboard<ProjectDashboardSummary>(projectId, 'summary', window),
  testResults: (projectId: string, window: AnalyticsWindow) =>
    projectDashboard<ProjectTestResultsView>(projectId, 'test-results', window),
  coverage: (projectId: string, window: AnalyticsWindow) =>
    projectDashboard<ProjectCoverageView>(projectId, 'coverage', window),
  defects: (projectId: string, window: AnalyticsWindow) =>
    projectDashboard<ProjectDefectsView>(projectId, 'defects', window),
  trends: (projectId: string, window: AnalyticsWindow) =>
    projectDashboard<ProjectTrendsView>(projectId, 'trends', window),
  organization: (window: AnalyticsWindow) =>
    apiFetch<OrganizationDashboard>(`/dashboard/organization${query({ ...window })}`),
};

export const jiraApi = {
  projects: () => apiFetch<ExternalProjectView[]>('/integrations/jira/projects'),
  issues: (params: { projectKey?: string; kind?: string } = {}) =>
    apiFetch<ExternalIssueView[]>(`/integrations/jira/issues${query(params)}`),
  references: (projectId: string, entityType: JiraSyncableEntity) =>
    apiFetch<ExternalReferenceView[]>(
      `/integrations/jira/references${query({ projectId, entityType })}`,
    ),
  sync: (entityType: JiraSyncableEntity, id: string) =>
    apiFetch<JiraSyncResultView>(
      `/integrations/jira/sync/${entityType === 'requirement' ? 'requirements' : 'defects'}/${id}`,
      { method: 'POST' },
    ),
};

const TESTRAIL_SYNC_PATH: Record<TestRailSyncableEntity, string> = {
  test_suite: 'test-suites',
  test_case: 'test-cases',
  test_run: 'test-runs',
  test_result: 'test-results',
};

export const testRailApi = {
  references: (params: ListTestRailReferencesQuery) =>
    apiFetch<ExternalReferenceView[]>(`/integrations/testrail/references${query(params)}`),
  sync: (entityType: TestRailSyncableEntity, id: string) =>
    apiFetch<TestRailSyncResultView>(
      `/integrations/testrail/sync/${TESTRAIL_SYNC_PATH[entityType]}/${id}`,
      { method: 'POST' },
    ),
};

export const externalTraceabilityApi = {
  list: (params: ExternalTraceabilityQuery) =>
    apiFetch<ExternalTraceabilityView>(`/integrations/traceability${query(params)}`),
  verify: (projectId: string) =>
    apiFetch<ExternalTraceabilityVerificationView>('/integrations/traceability/verify', {
      method: 'POST',
      body: { projectId },
    }),
};

export const gitHubApi = {
  repositories: () => apiFetch<ExternalRepositoryView[]>('/integrations/github/repositories'),
  workflowRuns: (params: ListWorkflowRunsQuery) =>
    apiFetch<ExternalWorkflowRunView[]>(`/integrations/github/runs${query(params)}`),
  references: (params: ListGitHubReferencesQuery) =>
    apiFetch<ExternalReferenceView[]>(`/integrations/github/references${query(params)}`),
  /** With a target: link (or re-link). Without: refresh what is linked. */
  linkRun: (testRunId: string, target: LinkWorkflowRunInput | null) =>
    apiFetch<GitHubSyncResultView>(`/integrations/github/sync/test-runs/${testRunId}`, {
      method: 'POST',
      ...(target === null ? {} : { body: target }),
    }),
  importResults: (testRunId: string) =>
    apiFetch<ImportAutomatedResultsView>(
      `/integrations/github/sync/test-runs/${testRunId}/results`,
      { method: 'POST' },
    ),
};

export const importsApi = {
  limits: (projectId: string) =>
    apiFetch<ImportLimitsView>(`/projects/${projectId}/imports/limits`),
  list: (projectId: string) => apiFetch<ImportJobView[]>(`/projects/${projectId}/imports`),
  get: (projectId: string, id: string) =>
    apiFetch<ImportJobView>(`/projects/${projectId}/imports/${id}`),
  /** Dry run: validates and plans; nothing is created until `commit`. */
  dryRun: (projectId: string, target: CreateImportQuery, file: File) => {
    const body = new FormData();
    body.append('file', file);
    return apiFetch<ImportJobView>(`/projects/${projectId}/imports${query({ ...target })}`, {
      method: 'POST',
      body,
    });
  },
  commit: (projectId: string, id: string) =>
    apiFetch<ImportCommitResult>(`/projects/${projectId}/imports/${id}/commit`, {
      method: 'POST',
    }),
};

export const exportsApi = {
  testCases: (projectId: string) => apiFetchBlob(`/projects/${projectId}/exports/test-cases.csv`),
  testRun: (runId: string) => apiFetchBlob(`/test-runs/${runId}/export.csv`),
  matrix: (projectId: string, uncoveredOnly = false) =>
    apiFetchBlob(
      `/traceability/matrix/export.csv${query({ projectId, uncoveredOnly: String(uncoveredOnly) })}`,
    ),
};

export const automationApi = {
  keys: (projectId: string) => apiFetch<ApiKeyView[]>(`/projects/${projectId}/api-keys`),
  /** The answer carries the full token; it is never returned again. */
  createKey: (projectId: string, input: CreateApiKeyInput) =>
    apiFetch<CreatedApiKeyView>(`/projects/${projectId}/api-keys`, {
      method: 'POST',
      body: input,
    }),
  revokeKey: (projectId: string, id: string) =>
    apiFetch<ApiKeyView>(`/projects/${projectId}/api-keys/${id}/revoke`, { method: 'POST' }),
  reports: (projectId: string) =>
    apiFetch<IngestionReportView[]>(`/projects/${projectId}/ingestion-reports`),
};

export const releasesApi = {
  list: (params: Omit<ListReleasesQuery, 'page' | 'pageSize'>) =>
    apiFetch<Paginated<ReleaseView>>(`/releases${query({ ...params, pageSize: 100 })}`),
  get: (id: string) => apiFetch<ReleaseView>(`/releases/${id}`),
  create: (body: CreateReleaseInput) =>
    apiFetch<ReleaseView>('/releases', { method: 'POST', body }),
  update: (id: string, body: UpdateReleaseInput) =>
    apiFetch<ReleaseView>(`/releases/${id}`, { method: 'PATCH', body }),
  transition: (id: string, action: 'start' | 'release' | 'archive') =>
    apiFetch<ReleaseView>(`/releases/${id}/${action}`, { method: 'POST' }),
  summary: (id: string) => apiFetch<ReleaseSummaryView>(`/releases/${id}/summary`),
  pipeline: (id: string, params: ReleasePipelineQuery = {}) =>
    apiFetch<ReleasePipelineView>(`/releases/${id}/pipeline${query(params)}`),
  traceability: (id: string) => apiFetch<ReleaseTraceabilityView>(`/releases/${id}/traceability`),
};

export const customFieldsApi = {
  list: (projectId: string, entityType?: CustomFieldEntity, includeArchived = false) =>
    apiFetch<CustomFieldView[]>(
      `/custom-fields${query({
        projectId,
        ...(entityType === undefined ? {} : { entityType }),
        includeArchived: String(includeArchived),
      })}`,
    ),
  create: (body: CreateCustomFieldInput) =>
    apiFetch<CustomFieldView>('/custom-fields', { method: 'POST', body }),
  update: (id: string, body: UpdateCustomFieldInput) =>
    apiFetch<CustomFieldView>(`/custom-fields/${id}`, { method: 'PATCH', body }),
  archive: (id: string) =>
    apiFetch<CustomFieldView>(`/custom-fields/${id}/archive`, { method: 'POST' }),
  restore: (id: string) =>
    apiFetch<CustomFieldView>(`/custom-fields/${id}/restore`, { method: 'POST' }),
};

export const defectWorkflowApi = {
  get: (projectId: string) =>
    apiFetch<DefectWorkflowView>(`/defect-workflow${query({ projectId })}`),
  update: (body: UpdateDefectWorkflowInput) =>
    apiFetch<DefectWorkflowView>('/defect-workflow', { method: 'PUT', body }),
};

export const workItemsApi = {
  list: (params: Omit<ListWorkItemsQuery, 'page' | 'pageSize'>) =>
    apiFetch<Paginated<WorkItemView>>(`/work-items${query({ ...params, pageSize: 100 })}`),
  get: (id: string) => apiFetch<WorkItemDetailView>(`/work-items/${id}`),
  linkRequirement: (id: string, requirementId: string) =>
    apiFetch<RequirementLinkResult>(`/work-items/${id}/requirements`, {
      method: 'POST',
      body: { requirementId },
    }),
  unlinkRequirement: (id: string, requirementId: string) =>
    apiFetch<void>(`/work-items/${id}/requirements/${requirementId}`, { method: 'DELETE' }),
  create: (body: CreateWorkItemInput) =>
    apiFetch<WorkItemView>('/work-items', { method: 'POST', body }),
  update: (id: string, body: UpdateWorkItemInput) =>
    apiFetch<WorkItemView>(`/work-items/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<void>(`/work-items/${id}`, { method: 'DELETE' }),
  move: (id: string, body: MoveWorkItemInput) =>
    apiFetch<WorkItemView>(`/work-items/${id}/move`, { method: 'POST', body }),
  tree: (params: Partial<WorkItemTreeQuery> & { projectId: string }) =>
    apiFetch<WorkItemTreeView>(`/work-items/tree${query(params)}`),
  reparent: (id: string, body: ReparentWorkItemInput) =>
    apiFetch<WorkItemView>(`/work-items/${id}/reparent`, { method: 'POST', body }),
  bulk: (body: BulkUpdateWorkItemsInput) =>
    apiFetch<BulkUpdateWorkItemsResult>('/work-items/bulk', { method: 'POST', body }),
};

export const sprintsApi = {
  list: (params: Omit<ListSprintsQuery, 'page' | 'pageSize'>) =>
    apiFetch<SprintListView>(`/sprints${query({ ...params, pageSize: 100 })}`),
  get: (id: string) => apiFetch<SprintDetailView>(`/sprints/${id}`),
  create: (body: CreateSprintInput) => apiFetch<SprintView>('/sprints', { method: 'POST', body }),
  update: (id: string, body: UpdateSprintInput) =>
    apiFetch<SprintView>(`/sprints/${id}`, { method: 'PATCH', body }),
  start: (id: string) => apiFetch<SprintView>(`/sprints/${id}/start`, { method: 'POST' }),
  close: (id: string, action: 'complete' | 'cancel', body: CloseSprintInput) =>
    apiFetch<CloseSprintResult>(`/sprints/${id}/${action}`, { method: 'POST', body }),
  addItems: (id: string, workItemIds: string[]) =>
    apiFetch<SprintDetailView>(`/sprints/${id}/items`, { method: 'POST', body: { workItemIds } }),
  removeItems: (id: string, workItemIds: string[]) =>
    apiFetch<SprintDetailView>(`/sprints/${id}/items/remove`, {
      method: 'POST',
      body: { workItemIds },
    }),
  board: (params: Partial<BoardQuery> & { projectId: string }) =>
    apiFetch<BoardView>(`/sprints/board${query(params)}`),
  moveCard: (id: string, body: MoveBoardCardInput) =>
    apiFetch<WorkItemView>(`/sprints/${id}/board/move`, { method: 'POST', body }),
};

export const developmentApi = {
  list: (params: Partial<ListDevelopmentArtifactsQuery> & { projectId: string }) =>
    apiFetch<Paginated<DevelopmentArtifactView>>(
      `/development-artifacts${query({ pageSize: 100, ...params })}`,
    ),
  get: (id: string) => apiFetch<DevelopmentArtifactView>(`/development-artifacts/${id}`),
  summary: (projectId: string) =>
    apiFetch<DevelopmentSummaryView>(`/development-artifacts/summary${query({ projectId })}`),
  create: (body: Partial<CreateDevelopmentArtifactInput> & { projectId: string; kind: string }) =>
    apiFetch<DevelopmentArtifactView>('/development-artifacts', { method: 'POST', body }),
  update: (id: string, body: UpdateDevelopmentArtifactInput) =>
    apiFetch<DevelopmentArtifactView>(`/development-artifacts/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<void>(`/development-artifacts/${id}`, { method: 'DELETE' }),
  forWorkItem: (workItemId: string) =>
    apiFetch<WorkItemDevelopmentView>(`/work-items/${workItemId}/development`),
  link: (workItemId: string, artifactId: string) =>
    apiFetch<DevelopmentLinkResult>(`/work-items/${workItemId}/development`, {
      method: 'POST',
      body: { artifactId },
    }),
  unlink: (workItemId: string, artifactId: string) =>
    apiFetch<void>(`/work-items/${workItemId}/development/${artifactId}`, { method: 'DELETE' }),
};

export const kanbanApi = {
  board: (params: Partial<KanbanQuery> & { projectId: string }) =>
    apiFetch<KanbanView>(`/kanban${query(params)}`),
  move: (body: MoveKanbanCardInput) =>
    apiFetch<WorkItemView>('/kanban/move', { method: 'POST', body }),
  setWipLimits: (body: UpdateWipLimitsInput) =>
    apiFetch<{ wipLimits: Array<number | null> }>('/kanban/wip-limits', { method: 'PUT', body }),
};

export const backlogApi = {
  get: (params: Partial<BacklogQuery> & { projectId: string }) =>
    apiFetch<BacklogView>(`/backlog${query(params)}`),
};

export const codeReviewsApi = {
  list: (params: Partial<ListCodeReviewsQuery> & { projectId: string }) =>
    apiFetch<Paginated<CodeReviewSummaryView>>(
      `/code-reviews${query({ pageSize: 100, ...params })}`,
    ),
  get: (id: string) => apiFetch<CodeReviewView>(`/code-reviews/${id}`),
  create: (body: Partial<CreateCodeReviewInput> & { projectId: string; title: string }) =>
    apiFetch<CodeReviewView>('/code-reviews', { method: 'POST', body }),
  remove: (id: string) => apiFetch<void>(`/code-reviews/${id}`, { method: 'DELETE' }),
  decide: (id: string, body: CodeReviewDecisionInput) =>
    apiFetch<CodeReviewView>(`/code-reviews/${id}/decision`, { method: 'POST', body }),
  addReviewer: (id: string, userId: string) =>
    apiFetch<CodeReviewView>(`/code-reviews/${id}/reviewers`, { method: 'POST', body: { userId } }),
  removeReviewer: (id: string, userId: string) =>
    apiFetch<void>(`/code-reviews/${id}/reviewers/${userId}`, { method: 'DELETE' }),
  dismissDecision: (id: string, userId: string) =>
    apiFetch<CodeReviewView>(`/code-reviews/${id}/reviewers/${userId}/dismiss`, {
      method: 'POST',
      body: {},
    }),
  dismiss: (id: string) =>
    apiFetch<CodeReviewView>(`/code-reviews/${id}/dismiss`, { method: 'POST', body: {} }),
  comment: (id: string, comment: string) =>
    apiFetch<CodeReviewView>(`/code-reviews/${id}/comments`, { method: 'POST', body: { comment } }),
  link: (id: string, workItemId: string) =>
    apiFetch<{ created: boolean }>(`/code-reviews/${id}/work-items`, {
      method: 'POST',
      body: { workItemId },
    }),
  unlink: (id: string, workItemId: string) =>
    apiFetch<void>(`/code-reviews/${id}/work-items/${workItemId}`, { method: 'DELETE' }),
  forWorkItem: (workItemId: string) =>
    apiFetch<CodeReviewSummaryView[]>(`/work-items/${workItemId}/code-reviews`),
  settings: (projectId: string) =>
    apiFetch<CodeReviewSettingsView>(`/code-reviews/settings${query({ projectId })}`),
  updateSettings: (projectId: string, requiredApprovals: number) =>
    apiFetch<CodeReviewSettingsView>('/code-reviews/settings', {
      method: 'PUT',
      body: { projectId, requiredApprovals },
    }),
};

export const buildsApi = {
  list: (params: Partial<ListBuildsQuery> & { projectId: string }) =>
    apiFetch<Paginated<BuildView>>(`/builds${query({ pageSize: 100, ...params })}`),
  get: (id: string) => apiFetch<BuildView>(`/builds/${id}`),
  metrics: (projectId: string, params: { releaseId?: string; branch?: string } = {}) =>
    apiFetch<BuildMetricsView>(`/builds/metrics${query({ projectId, ...params })}`),
  create: (body: Partial<CreateBuildInput> & { projectId: string; identifier: string }) =>
    apiFetch<CreateBuildResult>('/builds', { method: 'POST', body }),
  update: (id: string, body: UpdateBuildInput) =>
    apiFetch<BuildView>(`/builds/${id}`, { method: 'PATCH', body }),
  transition: (id: string, body: TransitionBuildInput) =>
    apiFetch<BuildView>(`/builds/${id}/transition`, { method: 'POST', body }),
};

export const environmentsApi = {
  list: (params: Partial<ListEnvironmentsQuery> & { projectId: string }) =>
    apiFetch<EnvironmentView[]>(`/environments${query(params)}`),
  get: (id: string) => apiFetch<EnvironmentView>(`/environments/${id}`),
  create: (body: Partial<CreateEnvironmentInput> & { projectId: string; name: string }) =>
    apiFetch<EnvironmentView>('/environments', { method: 'POST', body }),
  update: (id: string, body: UpdateEnvironmentInput) =>
    apiFetch<EnvironmentView>(`/environments/${id}`, { method: 'PATCH', body }),
  archive: (id: string, version?: number) =>
    apiFetch<EnvironmentView>(`/environments/${id}/archive`, {
      method: 'POST',
      body: version === undefined ? {} : { version },
    }),
  restore: (id: string, version?: number) =>
    apiFetch<EnvironmentView>(`/environments/${id}/restore`, {
      method: 'POST',
      body: version === undefined ? {} : { version },
    }),
  remove: (id: string) => apiFetch<void>(`/environments/${id}`, { method: 'DELETE' }),
  rollback: (id: string, body: RollbackEnvironmentInput) =>
    apiFetch<EnvironmentRollbackResult>(`/environments/${id}/rollback`, { method: 'POST', body }),
  rollbacks: (id: string) => apiFetch<DeploymentView[]>(`/environments/${id}/rollbacks`),
};

export const deploymentsApi = {
  list: (params: Partial<ListDeploymentsQuery> & { projectId: string }) =>
    apiFetch<Paginated<DeploymentView>>(`/deployments${query({ pageSize: 100, ...params })}`),
  get: (id: string) => apiFetch<DeploymentView>(`/deployments/${id}`),
  metrics: (projectId: string, params: { environmentId?: string; releaseId?: string } = {}) =>
    apiFetch<DeploymentMetricsView>(`/deployments/metrics${query({ projectId, ...params })}`),
  create: (
    body: Partial<CreateDeploymentInput> & {
      projectId: string;
      identifier: string;
      environmentId: string;
    },
  ) => apiFetch<CreateDeploymentResult>('/deployments', { method: 'POST', body }),
  transition: (id: string, body: TransitionDeploymentInput) =>
    apiFetch<DeploymentView>(`/deployments/${id}/transition`, { method: 'POST', body }),
  rollback: (id: string, body: RollbackDeploymentInput) =>
    apiFetch<DeploymentView>(`/deployments/${id}/rollback`, { method: 'POST', body }),
};

export const qualityGatesApi = {
  list: (projectId: string) => apiFetch<QualityGateView[]>(`/quality-gates${query({ projectId })}`),
  create: (body: CreateQualityGateInput) =>
    apiFetch<QualityGateView>('/quality-gates', { method: 'POST', body }),
  update: (id: string, body: UpdateQualityGateInput) =>
    apiFetch<QualityGateView>(`/quality-gates/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<void>(`/quality-gates/${id}`, { method: 'DELETE' }),
  evaluate: (releaseId: string, environmentId?: string) =>
    apiFetch<ReleaseQualityGatesView>(
      `/releases/${releaseId}/quality-gates${query(environmentId === undefined ? {} : { environmentId })}`,
    ),
  override: (releaseId: string, environmentId: string, reason: string) =>
    apiFetch<ReleaseQualityGatesView>(`/releases/${releaseId}/quality-gates/override`, {
      method: 'POST',
      body: { environmentId, reason },
    }),
};

export const releaseApprovalsApi = {
  rules: (projectId: string) =>
    apiFetch<ApprovalRuleView[]>(`/release-approval-rules${query({ projectId })}`),
  createRule: (body: CreateApprovalRuleInput) =>
    apiFetch<ApprovalRuleView>('/release-approval-rules', { method: 'POST', body }),
  updateRule: (id: string, body: UpdateApprovalRuleInput) =>
    apiFetch<ApprovalRuleView>(`/release-approval-rules/${id}`, { method: 'PATCH', body }),
  removeRule: (id: string) => apiFetch<void>(`/release-approval-rules/${id}`, { method: 'DELETE' }),
  view: (releaseId: string, environmentId?: string) =>
    apiFetch<ReleaseApprovalsView>(
      `/releases/${releaseId}/approvals${query(environmentId === undefined ? {} : { environmentId })}`,
    ),
  decide: (releaseId: string, body: DecideApprovalInput) =>
    apiFetch<ReleaseApprovalsView>(`/releases/${releaseId}/approvals`, { method: 'POST', body }),
  revoke: (releaseId: string, approvalId: string, reason?: string) =>
    apiFetch<ReleaseApprovalsView>(`/releases/${releaseId}/approvals/${approvalId}/revoke`, {
      method: 'POST',
      body: reason === undefined ? {} : { reason },
    }),
};

export const testPlansApi = {
  list: (params: Omit<ListTestPlansQuery, 'page' | 'pageSize'>) =>
    apiFetch<Paginated<TestPlanView>>(`/test-plans${query({ ...params, pageSize: 100 })}`),
  get: (id: string) => apiFetch<TestPlanView>(`/test-plans/${id}`),
  progress: (id: string) => apiFetch<TestPlanProgressView>(`/test-plans/${id}/progress`),
  create: (body: Partial<CreateTestPlanInput> & { projectId: string; name: string }) =>
    apiFetch<TestPlanView>('/test-plans', { method: 'POST', body }),
  update: (id: string, body: UpdateTestPlanInput) =>
    apiFetch<TestPlanView>(`/test-plans/${id}`, { method: 'PATCH', body }),
  action: (
    id: string,
    action: 'start' | 'complete' | 'cancel' | 'archive' | 'scope/refresh',
    version?: number,
  ) =>
    apiFetch<TestPlanView>(`/test-plans/${id}/${action}`, {
      method: 'POST',
      body: version === undefined ? {} : { version },
    }),
  attachRun: (id: string, testRunId: string) =>
    apiFetch<TestPlanView>(`/test-plans/${id}/runs`, { method: 'POST', body: { testRunId } }),
  detachRun: (id: string, testRunId: string) =>
    apiFetch<TestPlanView>(`/test-plans/${id}/runs/${testRunId}`, { method: 'DELETE' }),
};

export const testCyclesApi = {
  list: (testPlanId: string) =>
    apiFetch<Paginated<TestCycleView>>(`/test-cycles${query({ testPlanId, pageSize: 100 })}`),
  get: (id: string) => apiFetch<TestCycleView>(`/test-cycles/${id}`),
  progress: (id: string) => apiFetch<TestCycleProgressView>(`/test-cycles/${id}/progress`),
  create: (body: Partial<CreateTestCycleInput> & { testPlanId: string; name: string }) =>
    apiFetch<TestCycleView>('/test-cycles', { method: 'POST', body }),
  update: (id: string, body: UpdateTestCycleInput) =>
    apiFetch<TestCycleView>(`/test-cycles/${id}`, { method: 'PATCH', body }),
  action: (id: string, action: 'start' | 'complete' | 'cancel' | 'archive', version?: number) =>
    apiFetch<TestCycleView>(`/test-cycles/${id}/${action}`, {
      method: 'POST',
      body: version === undefined ? {} : { version },
    }),
  attachRun: (id: string, testRunId: string) =>
    apiFetch<TestCycleView>(`/test-cycles/${id}/runs`, { method: 'POST', body: { testRunId } }),
  detachRun: (id: string, testRunId: string) =>
    apiFetch<TestCycleView>(`/test-cycles/${id}/runs/${testRunId}`, { method: 'DELETE' }),
};
