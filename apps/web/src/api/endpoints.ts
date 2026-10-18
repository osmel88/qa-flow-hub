import type {
  AttachableEntity,
  AttachmentLimitsView,
  AttachmentView,
  AuthSession,
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
  RequirementView,
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
  login: (body: LoginInput) =>
    apiFetch<AuthSession>('/auth/login', {
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

export const organizationsApi = {
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
  list: (params: { projectId: string; status?: string; priority?: string; search?: string }) =>
    apiFetch<Paginated<RequirementView>>(`/requirements${query({ ...params, pageSize: 100 })}`),
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
};

export const testRunsApi = {
  list: (params: { projectId: string; status?: string }) =>
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
