import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditAction, ImportJob, Prisma, ProjectStatus } from '@prisma/client';
import {
  CreateImportQuery,
  IMPORT_ISSUE_CODES,
  ImportCommitResult,
  ImportIssue,
  ImportJobView,
  ImportLimitsView,
  ImportSummary,
  MAX_IMPORT_SECTION_DEPTH,
  MAX_STORED_IMPORT_ISSUES,
} from '@qa-flow-hub/shared';
import { z } from 'zod';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { ConflictError, ImportStaleError, NotFoundError, ValidationError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import {
  StoredPlan,
  findInFileDuplicates,
  fingerprintOf,
  sectionKey,
  storedPlanSchema,
} from './import-plan';
import { ImportsRepository } from './imports.repository';
import {
  DraftCase,
  MAX_STEPS_PER_CASE,
  QAFLOW_DIALECT,
  issue,
  normalizeTitle,
  validateCases,
} from './parsing/case-draft';
import {
  DEFAULT_MAX_COLUMNS,
  DEFAULT_MAX_RECORD_BYTES,
  decodeCsvText,
  parseCsvTable,
} from './parsing/csv-input';
import { parseQaflowCsv } from './parsing/qaflow-csv.parser';
import { TESTRAIL_DIALECT, parseTestrailCsv } from './parsing/testrail-csv.parser';

/** Ready jobs kept per project; a new dry run expires the oldest beyond it. */
export const MAX_READY_JOBS_PER_PROJECT = 20;
const HISTORY_SIZE = 50;

export interface UploadedImportFile {
  fileName: string;
  buffer: Buffer;
}

interface PlannedCase {
  draft: DraftCase;
  suiteName: string;
  requirementIds: string[];
}

interface Resolution {
  suites: Array<{ name: string; id: string | null }>;
  newSections: Array<{ suiteName: string; path: string[] }>;
  creates: PlannedCase[];
  duplicates: number;
  issues: ImportIssue[];
  fingerprint: string;
}

const summarySchema = z.object({
  rows: z.number().default(0),
  cases: z.number().default(0),
  steps: z.number().default(0),
  newSuites: z.number().default(0),
  newSections: z.number().default(0),
  links: z.number().default(0),
  duplicates: z.number().default(0),
  errors: z.number().default(0),
  warnings: z.number().default(0),
});

const issuesSchema = z.array(
  z.object({
    row: z.number(),
    column: z.string().nullable(),
    code: z.enum(IMPORT_ISSUE_CODES),
    severity: z.enum(['error', 'warning']),
    message: z.string(),
  }),
);

/**
 * Import of test cases from a CSV file in two steps.
 *
 * The dry run parses and validates the file, resolves it against the project
 * (existing suites, sections, duplicates, requirement keys) and stores the
 * resulting plan in an `import_jobs` row. It writes no suite, section, case,
 * step or link; the file itself is never stored.
 *
 * The commit applies that stored plan — never a new upload — in one database
 * transaction, under a per-project advisory lock, after resolving it again and
 * refusing if the project moved since the dry run (`IMPORT_STALE`).
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly repository: ImportsRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  limits(): ImportLimitsView {
    const limits = this.config.imports;
    return {
      maxBytes: limits.maxBytes,
      maxRows: limits.maxRows,
      maxCases: limits.maxCases,
      maxColumns: DEFAULT_MAX_COLUMNS,
      maxStepsPerCase: MAX_STEPS_PER_CASE,
      maxSectionDepth: MAX_IMPORT_SECTION_DEPTH,
      jobTtlHours: limits.jobTtlHours,
    };
  }

  async dryRun(
    projectId: string,
    query: CreateImportQuery,
    file: UploadedImportFile,
    userId: string,
  ): Promise<ImportJobView> {
    const project = await this.requireWritableProject(projectId);
    const limits = this.config.imports;
    const targetName = await this.targetSuiteName(project.id, query);
    const fileName = safeFileName(file.fileName);

    const issues: ImportIssue[] = [];
    let drafts: DraftCase[] = [];
    let rows = 0;
    let resolution: Resolution | null = null;

    // Size, encoding and binary checks refuse the request outright (413/415);
    // a malformed CSV is a finding of the dry run and gets a report.
    const text = decodeCsvText(file.buffer, limits.maxBytes);
    try {
      const table = parseCsvTable(text, {
        maxBytes: limits.maxBytes,
        maxRows: limits.maxRows,
        maxColumns: DEFAULT_MAX_COLUMNS,
        maxRecordBytes: DEFAULT_MAX_RECORD_BYTES,
      });
      rows = table.records.length;
      const parsed =
        query.format === 'qaflow_csv' ? parseQaflowCsv(table) : parseTestrailCsv(table);
      const validated = validateCases(
        parsed.cases,
        query.format === 'qaflow_csv' ? QAFLOW_DIALECT : TESTRAIL_DIALECT,
      );
      issues.push(...parsed.issues, ...validated.issues);

      if (validated.drafts.length > limits.maxCases) {
        issues.push(
          issue(
            1,
            null,
            'TOO_MANY_CASES',
            `The file has ${validated.drafts.length} cases; the limit is ${limits.maxCases}`,
          ),
        );
      } else {
        const unique = findInFileDuplicates(validated.drafts, targetName);
        issues.push(...unique.issues);
        drafts = unique.unique;
        const canLink = await this.access.hasPermission(project.id, 'traceability.manage');
        resolution = await this.resolve(project.id, drafts, targetName, canLink);
        issues.push(...resolution.issues);
      }
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }
      issues.push(issue(1, null, 'MALFORMED_CSV', error.message));
    }

    issues.sort(
      (a, b) => a.row - b.row || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1),
    );
    const errors = issues.filter((entry) => entry.severity === 'error').length;
    const summary: ImportSummary = {
      rows,
      cases: resolution?.creates.length ?? 0,
      steps:
        resolution?.creates.reduce((total, planned) => total + planned.draft.steps.length, 0) ?? 0,
      newSuites: resolution?.suites.filter((suite) => suite.id === null).length ?? 0,
      newSections: resolution?.newSections.length ?? 0,
      links:
        resolution?.creates.reduce((total, planned) => total + planned.requirementIds.length, 0) ??
        0,
      duplicates: resolution?.duplicates ?? 0,
      errors,
      warnings: issues.length - errors,
    };
    const ready = errors === 0 && resolution !== null;
    const plan: StoredPlan | null =
      ready && resolution !== null
        ? { version: 1, fingerprint: resolution.fingerprint, drafts }
        : null;

    const now = new Date();
    await this.repository.expireStale(project.id, now);
    if (ready) {
      await this.repository.expireOldestReady(project.id, MAX_READY_JOBS_PER_PROJECT - 1);
    }
    const job = await this.repository.createJob({
      projectId: project.id,
      createdById: userId,
      format: query.format,
      status: ready ? 'ready' : 'invalid',
      fileName,
      fileSizeBytes: file.buffer.length,
      checksum: createHash('sha256').update(file.buffer).digest('hex'),
      targetSuiteId: query.suiteId ?? null,
      targetSuiteName: targetName,
      summary: summary as unknown as Prisma.InputJsonValue,
      issues: issues.slice(0, MAX_STORED_IMPORT_ISSUES) as unknown as Prisma.InputJsonValue,
      issueCount: issues.length,
      plan: plan === null ? Prisma.DbNull : plan,
      expiresAt: new Date(now.getTime() + this.config.imports.jobTtlHours * 3_600_000),
    });

    return toJobView(job, true);
  }

  /** For routes that only need the route permission checked in this project. */
  async assertAccess(projectId: string): Promise<void> {
    await this.requireProject(projectId);
  }

  async list(projectId: string): Promise<ImportJobView[]> {
    const project = await this.requireProject(projectId);
    await this.repository.expireStale(project.id, new Date());
    const jobs = await this.repository.listJobs(project.id, HISTORY_SIZE);
    return jobs.map((job) => toJobView(job, false));
  }

  async get(projectId: string, id: string): Promise<ImportJobView> {
    const project = await this.requireProject(projectId);
    await this.repository.expireStale(project.id, new Date());
    const job = await this.repository.findJob(project.id, id);
    if (job === null) {
      throw new NotFoundError('Import job');
    }
    return toJobView(job, true);
  }

  async commit(projectId: string, id: string, userId: string): Promise<ImportCommitResult> {
    const project = await this.requireWritableProject(projectId);
    const job = await this.repository.findJob(project.id, id);
    // Bound to its author: a colleague with the same permission runs their own
    // dry run rather than applying a plan they have not reviewed.
    if (job === null || job.createdById !== userId) {
      throw new NotFoundError('Import job');
    }
    if (job.status === 'ready' && job.expiresAt.getTime() <= Date.now()) {
      await this.repository.markExpired(job.id);
      throw new ConflictError('The dry run expired; upload the file again');
    }
    assertReady(job);
    const parsedPlan = storedPlanSchema.safeParse(job.plan);
    if (!parsedPlan.success) {
      throw new ConflictError('The stored plan is not readable; run the dry run again');
    }
    const plan = parsedPlan.data;
    const targetName = job.targetSuiteName ?? '';
    const canLink = await this.access.hasPermission(project.id, 'traceability.manage');

    return this.prisma.runInTransaction(
      async (tx) => {
        await this.repository.lockProject(project.id, tx);
        const current = await this.repository.findJob(project.id, job.id, tx);
        if (current === null) {
          throw new NotFoundError('Import job');
        }
        assertReady(current);
        if (
          job.targetSuiteId !== null &&
          (await this.repository.findSuiteById(project.id, job.targetSuiteId, tx)) === null
        ) {
          throw new ImportStaleError('the target suite was deleted');
        }

        const resolution = await this.resolve(project.id, plan.drafts, targetName, canLink, tx);
        if (resolution.issues.some((entry) => entry.severity === 'error')) {
          throw new ImportStaleError(
            resolution.issues.find((entry) => entry.severity === 'error')?.message ?? 'validation',
          );
        }
        if (resolution.fingerprint !== plan.fingerprint) {
          throw new ImportStaleError('suites, sections, cases or requirements changed');
        }

        const created = await this.apply(project.id, resolution, userId, tx);
        const summary = {
          ...summarySchema.parse(job.summary),
          ...{ cases: created.cases, steps: created.steps, links: created.links },
        };
        if (!(await this.repository.markCommitted(job.id, summary, tx))) {
          throw new ConflictError('The import was already committed');
        }
        await this.audit.record(
          {
            action: AuditAction.create,
            entityType: 'ImportJob',
            entityId: job.id,
            summary: `Imported ${created.cases} cases (${created.steps} steps, ${created.links} links) from ${job.fileName}`,
            changes: {
              format: job.format,
              checksum: job.checksum,
              ...created,
            },
          },
          tx,
        );

        const committed = await this.repository.findJob(project.id, job.id, tx);
        if (committed === null) {
          throw new NotFoundError('Import job');
        }
        return { job: toJobView(committed, true), created };
      },
      { timeoutMs: this.config.imports.transactionTimeoutMs },
    );
  }

  /**
   * Resolves validated drafts against the project as it is now. Pure reads, so
   * the dry run and the commit (inside its transaction) share it, and the
   * fingerprint of what it decided is what tells the commit the plan is stale.
   */
  private async resolve(
    projectId: string,
    drafts: DraftCase[],
    targetName: string,
    canLink: boolean,
    tx?: PrismaTransaction,
  ): Promise<Resolution> {
    const issues: ImportIssue[] = [];
    const suiteOf = (draft: DraftCase): string => draft.suiteName ?? targetName;

    const names = [...new Set(drafts.map(suiteOf))];
    const suites = await this.repository.findSuitesByName(projectId, names, tx);
    const suiteByName = new Map(suites.map((suite) => [suite.name, suite]));
    const blockedSuites = new Set<string>();
    for (const name of names) {
      if (suiteByName.get(name)?.deletedAt != null) {
        blockedSuites.add(name);
        const first = drafts.find((draft) => suiteOf(draft) === name);
        issues.push(
          issue(
            first?.line ?? 1,
            'suite',
            'DUPLICATE_EXISTING',
            `A deleted suite still holds the name "${name}"; choose another name`,
          ),
        );
      }
    }
    const liveSuiteIds = suites
      .filter((suite) => suite.deletedAt === null)
      .map((suite) => suite.id);

    // Existing sections, keyed by suite name + path. The oldest wins when two
    // siblings share a name, so the choice is stable across dry run and commit.
    const sections = (await this.repository.listSections(liveSuiteIds, tx)).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    const sectionById = new Map(sections.map((section) => [section.id, section]));
    const suiteNameById = new Map(suites.map((suite) => [suite.id, suite.name]));
    const sectionIdByKey = new Map<string, string>();
    for (const section of sections) {
      const path: string[] = [];
      let cursor: typeof section | undefined = section;
      while (cursor !== undefined && path.length <= MAX_IMPORT_SECTION_DEPTH + 5) {
        path.unshift(cursor.name);
        cursor = cursor.parentId === null ? undefined : sectionById.get(cursor.parentId);
      }
      const key = sectionKey(suiteNameById.get(section.suiteId) ?? '', path);
      if (!sectionIdByKey.has(key)) {
        sectionIdByKey.set(key, section.id);
      }
    }

    const existing = new Set(
      (await this.repository.listCaseTitles(projectId, liveSuiteIds, tx)).map(
        (testCase) =>
          `${testCase.suiteId}|${testCase.sectionId ?? ''}|${normalizeTitle(testCase.title)}`,
      ),
    );

    const keys = [...new Set(drafts.flatMap((draft) => draft.references))];
    const requirements = canLink
      ? await this.repository.findRequirementsByKey(projectId, keys, tx)
      : [];
    const requirementByKey = new Map(
      requirements.map((requirement) => [requirement.key, requirement.id]),
    );

    const creates: PlannedCase[] = [];
    const newSections: Resolution['newSections'] = [];
    const plannedSections = new Set<string>();
    const decisions: unknown[] = [];
    let duplicates = 0;

    for (const draft of drafts) {
      const suiteName = suiteOf(draft);
      if (blockedSuites.has(suiteName)) {
        continue;
      }
      if (draft.references.length > 0 && !canLink) {
        issues.push(
          issue(
            draft.line,
            'references',
            'REFERENCE_NOT_ALLOWED',
            'Linking requirements needs traceability.manage in this project',
          ),
        );
        continue;
      }
      const suiteId = suiteByName.get(suiteName)?.id ?? null;
      const sectionId =
        draft.sectionPath.length === 0
          ? null
          : (sectionIdByKey.get(sectionKey(suiteName, draft.sectionPath)) ?? undefined);

      if (
        suiteId !== null &&
        sectionId !== undefined &&
        existing.has(`${suiteId}|${sectionId ?? ''}|${draft.normalizedTitle}`)
      ) {
        duplicates += 1;
        issues.push(
          issue(
            draft.line,
            'title',
            'DUPLICATE_EXISTING',
            `"${draft.title}" already exists in this suite and section; skipped`,
            'warning',
          ),
        );
        decisions.push([draft.line, 'skip', suiteId, sectionId]);
        continue;
      }

      const requirementIds: string[] = [];
      for (const key of draft.references) {
        const requirementId = requirementByKey.get(key);
        if (requirementId === undefined) {
          issues.push(
            issue(
              draft.line,
              'references',
              'UNKNOWN_REFERENCE',
              `No requirement ${key} in this project; the link is skipped`,
              'warning',
            ),
          );
        } else {
          requirementIds.push(requirementId);
        }
      }

      for (let depth = 1; depth <= draft.sectionPath.length; depth += 1) {
        const path = draft.sectionPath.slice(0, depth);
        const key = sectionKey(suiteName, path);
        if (!sectionIdByKey.has(key) && !plannedSections.has(key)) {
          plannedSections.add(key);
          newSections.push({ suiteName, path });
        }
      }
      creates.push({ draft, suiteName, requirementIds });
      decisions.push([
        draft.line,
        'create',
        suiteId,
        sectionId === undefined ? 'new' : sectionId,
        requirementIds,
      ]);
    }

    return {
      suites: names
        .filter((name) => !blockedSuites.has(name))
        .map((name) => ({ name, id: suiteByName.get(name)?.id ?? null })),
      newSections: newSections.sort((a, b) => a.path.length - b.path.length),
      creates,
      duplicates,
      issues,
      fingerprint: fingerprintOf(decisions),
    };
  }

  /** The writes of a commit, all inside the caller's transaction. */
  private async apply(
    projectId: string,
    resolution: Resolution,
    userId: string,
    tx: PrismaTransaction,
  ): Promise<ImportCommitResult['created']> {
    const suiteIds = new Map<string, string>();
    let newSuites = 0;
    for (const suite of resolution.suites) {
      if (suite.id !== null) {
        suiteIds.set(suite.name, suite.id);
      } else if (resolution.creates.some((planned) => planned.suiteName === suite.name)) {
        suiteIds.set(suite.name, (await this.repository.createSuite(projectId, suite.name, tx)).id);
        newSuites += 1;
      }
    }

    const existingSections = await this.repository.listSections([...suiteIds.values()], tx);
    const sectionIds = new Map<string, string>();
    const byId = new Map(existingSections.map((section) => [section.id, section]));
    const nameBySuiteId = new Map([...suiteIds].map(([name, id]) => [id, name]));
    for (const section of existingSections.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    )) {
      const path: string[] = [];
      let cursor: typeof section | undefined = section;
      while (cursor !== undefined && path.length <= MAX_IMPORT_SECTION_DEPTH + 5) {
        path.unshift(cursor.name);
        cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
      }
      const key = sectionKey(nameBySuiteId.get(section.suiteId) ?? '', path);
      if (!sectionIds.has(key)) {
        sectionIds.set(key, section.id);
      }
    }
    for (const section of resolution.newSections) {
      const suiteId = suiteIds.get(section.suiteName);
      if (suiteId === undefined) {
        throw new ImportStaleError('a planned suite is missing');
      }
      const parentId =
        section.path.length === 1
          ? null
          : (sectionIds.get(sectionKey(section.suiteName, section.path.slice(0, -1))) ?? null);
      const name = section.path[section.path.length - 1] ?? '';
      sectionIds.set(
        sectionKey(section.suiteName, section.path),
        (await this.repository.createSection(suiteId, parentId, name, tx)).id,
      );
    }

    if (resolution.creates.length === 0) {
      return {
        cases: 0,
        steps: 0,
        sections: resolution.newSections.length,
        suites: newSuites,
        links: 0,
      };
    }

    const { projectKey, first } = await this.repository.reserveCaseKeys(
      projectId,
      resolution.creates.length,
      tx,
    );
    const keyed = resolution.creates.map((planned, index) => ({
      planned,
      key: `${projectKey}-C-${first + index}`,
    }));
    const rows = await this.repository.createCases(
      keyed.map(({ planned, key }) => {
        const draft = planned.draft;
        const suiteId = suiteIds.get(planned.suiteName);
        if (suiteId === undefined) {
          throw new ImportStaleError('a planned suite is missing');
        }
        return {
          projectId,
          suiteId,
          sectionId:
            draft.sectionPath.length === 0
              ? null
              : (sectionIds.get(sectionKey(planned.suiteName, draft.sectionPath)) ?? null),
          key,
          title: draft.title,
          description: draft.description,
          preconditions: draft.preconditions,
          expectedResult: draft.expectedResult,
          type: draft.type,
          priority: draft.priority,
          status: draft.status,
          automationStatus: draft.automationStatus,
          estimateMinutes: draft.estimateMinutes,
          tags: draft.tags,
          createdById: userId,
        };
      }),
      tx,
    );
    const idByKey = new Map(rows.map((row) => [row.key, row.id]));
    const steps: Array<{
      testCaseId: string;
      position: number;
      action: string;
      expectedResult: string | null;
      data: string | null;
    }> = [];
    const links: Array<{ requirementId: string; testCaseId: string }> = [];
    for (const { planned, key } of keyed) {
      const testCaseId = idByKey.get(key);
      if (testCaseId === undefined) {
        throw new ConflictError('A created case could not be read back');
      }
      planned.draft.steps.forEach((step, index) =>
        steps.push({ testCaseId, position: index + 1, ...step }),
      );
      planned.requirementIds.forEach((requirementId) => links.push({ requirementId, testCaseId }));
    }
    await this.repository.createSteps(steps, tx);
    await this.repository.createVerifiesLinks(links, userId, tx);

    return {
      cases: rows.length,
      steps: steps.length,
      sections: resolution.newSections.length,
      suites: newSuites,
      links: links.length,
    };
  }

  private async targetSuiteName(projectId: string, query: CreateImportQuery): Promise<string> {
    if (query.suiteId !== undefined) {
      const suite = await this.repository.findSuiteById(projectId, query.suiteId);
      if (suite === null) {
        throw new NotFoundError('Test suite');
      }
      return suite.name;
    }
    return query.suiteName ?? '';
  }

  private async requireProject(projectId: string) {
    const project = await this.projects.findById(projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);
    return project;
  }

  private async requireWritableProject(projectId: string) {
    const project = await this.requireProject(projectId);
    if (project.status === ProjectStatus.archived || project.archivedAt !== null) {
      throw new ConflictError('The project is archived; restore it before importing');
    }
    return project;
  }
}

function assertReady(job: ImportJob): void {
  if (job.status === 'committed') {
    throw new ConflictError('The import was already committed');
  }
  if (job.status === 'invalid') {
    throw new ConflictError('The dry run found errors; fix the file and upload it again');
  }
  if (job.status === 'expired') {
    throw new ConflictError('The dry run expired; upload the file again');
  }
}

/** Only the base name, printable, bounded: it is shown in the history and the audit log. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- the point is to remove them
  const printable = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (printable.length === 0 ? 'import.csv' : printable).slice(0, 200);
}

export function toJobView(job: ImportJob, withIssues: boolean): ImportJobView {
  const issues = issuesSchema.safeParse(job.issues);
  return {
    id: job.id,
    projectId: job.projectId,
    createdById: job.createdById,
    format: job.format,
    status: job.status,
    fileName: job.fileName,
    fileSizeBytes: job.fileSizeBytes,
    checksum: job.checksum,
    targetSuiteId: job.targetSuiteId,
    targetSuiteName: job.targetSuiteName,
    summary: summarySchema.parse(job.summary ?? {}),
    ...(withIssues ? { issues: issues.success ? issues.data : [] } : {}),
    issueCount: job.issueCount,
    expiresAt: job.expiresAt.toISOString(),
    committedAt: job.committedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
  };
}
