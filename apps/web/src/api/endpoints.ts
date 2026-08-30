import type {
  AuthSession,
  ChangePasswordInput,
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
  DefectView,
  InvitationView,
  LoginInput,
  MemberView,
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
  TestRunView,
  TraceLinkView,
  TraceabilityMatrix,
  UpdateDefectInput,
  UpdateTestCaseInput,
} from '@qa-flow-hub/shared';
import { apiFetch, query } from './http-client';

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
    apiFetch<OrganizationSummary>('/organizations/invitations/accept', {
      method: 'POST',
      body: { token },
      withoutOrganization: true,
    }),
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
  grantRole: (projectId: string, userId: string, role: string) =>
    apiFetch<ProjectMemberView>(`/projects/${projectId}/members`, {
      method: 'POST',
      body: { userId, role },
    }),
  revokeRole: (projectId: string, userId: string) =>
    apiFetch<void>(`/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),
};

export const requirementsApi = {
  list: (params: { projectId: string; status?: string; priority?: string; search?: string }) =>
    apiFetch<Paginated<RequirementView>>(`/requirements${query({ ...params, pageSize: 100 })}`),
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

export const dashboardApi = {
  summary: (projectId?: string) => apiFetch<DashboardSummary>(`/dashboard${query({ projectId })}`),
};
