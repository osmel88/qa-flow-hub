import { Injectable } from '@nestjs/common';
import {
  ApiKey,
  ApiKeyScope as DbApiKeyScope,
  AuditAction,
  IngestionReport,
  Prisma,
  ProjectStatus,
  TestRunStatus,
} from '@prisma/client';
import {
  IngestReportQuery,
  IngestedTestOutcome,
  IngestionFormat,
  IngestionRecordedView,
  IngestionReportView,
  IngestionResultView,
  IngestionSummary,
  IngestionUnmatchedView,
  idempotencyKeySchema,
} from '@qa-flow-hub/shared';
import { createHash } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { TestRunsRepository } from '../test-runs/test-runs.repository';
import { snapshotOf } from '../test-runs/test-runs.service';
import { prefixOf, tokenMatches } from './api-key-token';
import { ApiKeysRepository } from './api-keys.repository';
import { IngestionRepository } from './ingestion.repository';
import { ReleasesService } from '../releases/releases.service';
import { caseKeysIn } from './parsing/case-keys';
import { parseJUnitXml } from './parsing/junit-xml.parser';
import { parsePlaywrightJson } from './parsing/playwright-json.parser';
import { MAX_ERROR_LENGTH, ParsedReport, ParsedTest, truncate } from './parsing/report';

/** One message for every way a key can be wrong: no oracle for which part. */
const INVALID_KEY_MESSAGE = 'The API key is invalid, expired or revoked';
/** Unmatched tests kept in the stored summary; the counts stay exact. */
const MAX_UNMATCHED_STORED = 500;

export interface AuthenticatedKey {
  key: ApiKey;
  organizationId: string;
}

export interface IncomingReport {
  format: IngestionFormat;
  fileName: string;
  buffer: Buffer;
  idempotencyKey: string | undefined;
  query: IngestReportQuery;
}

type StoredReport = IngestionReport & { apiKey: { prefix: string } | null };

interface StoredSummary {
  summary: IngestionSummary;
  recorded: IngestionRecordedView[];
  unmatched: IngestionUnmatchedView[];
}

/**
 * Turns an uploaded report into results of a test run, all or nothing.
 *
 * The request carries no JWT and no X-Organization-Id: the tenant comes from
 * the API key. `authenticate` resolves it, and `ingest` must be called inside
 * `tenant.runForOrganization(organizationId)` so every query runs under that
 * organization's RLS.
 */
@Injectable()
export class IngestionService {
  constructor(
    private readonly keys: ApiKeysRepository,
    private readonly reports: IngestionRepository,
    private readonly projects: ProjectsRepository,
    private readonly runs: TestRunsRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly releases: ReleasesService,
  ) {}

  /** Resolves the organization of a token; verification happens in `verify`. */
  async organizationOf(token: string | null): Promise<string> {
    const prefix = token === null ? null : prefixOf(token);
    if (prefix === null) {
      throw new UnauthenticatedError(INVALID_KEY_MESSAGE);
    }
    const organizationId = await this.keys.organizationForPrefix(prefix);
    if (organizationId === null) {
      throw new UnauthenticatedError(INVALID_KEY_MESSAGE);
    }
    return organizationId;
  }

  /**
   * Checks the secret, the state and the scope of the key, under the tenant
   * `organizationOf` returned. A failed attempt on a real key is audited: it
   * is either a leaked prefix or a pipeline still using a revoked key.
   */
  async verify(token: string, scope: DbApiKeyScope): Promise<ApiKey> {
    const prefix = prefixOf(token);
    const key = prefix === null ? null : await this.keys.findByPrefix(prefix);
    if (key === null) {
      throw new UnauthenticatedError(INVALID_KEY_MESSAGE);
    }
    const now = new Date();
    const problem = !tokenMatches(token, key.secretHash)
      ? 'wrong secret'
      : key.revokedAt !== null
        ? 'revoked'
        : key.expiresAt !== null && key.expiresAt <= now
          ? 'expired'
          : null;
    if (problem !== null) {
      await this.auditRejected(key, problem);
      throw new UnauthenticatedError(INVALID_KEY_MESSAGE);
    }
    if (!key.scopes.includes(scope)) {
      await this.auditRejected(key, `missing scope ${scope}`);
      throw new ForbiddenError('The API key does not have the scope this endpoint requires');
    }
    return key;
  }

  async ingest(key: ApiKey, incoming: IncomingReport): Promise<IngestionResultView> {
    const project = await this.projects.findById(key.projectId);
    if (project === null) {
      throw new UnauthenticatedError(INVALID_KEY_MESSAGE);
    }
    if (project.status === ProjectStatus.archived || project.archivedAt !== null) {
      throw new ConflictError('The project is archived; restore it before ingesting results');
    }

    const checksum = createHash('sha256').update(incoming.buffer).digest('hex');
    const idempotencyKey = this.idempotencyKey(incoming.idempotencyKey, checksum);

    const existing = await this.reports.findReport(project.id, idempotencyKey);
    if (existing !== null) {
      return this.duplicate(existing, checksum);
    }

    // Parsing is pure and happens before any transaction: an invalid report is
    // rejected without touching the database.
    const limits = { maxTests: this.config.ingestion.maxTests };
    const parsed =
      incoming.format === 'junit_xml'
        ? parseJUnitXml(incoming.buffer, limits)
        : parsePlaywrightJson(incoming.buffer, limits);

    try {
      return await this.prisma.runInTransaction(
        (tx) => this.record(tx, key, project, incoming, parsed, checksum, idempotencyKey),
        { timeoutMs: this.config.ingestion.transactionTimeoutMs },
      );
    } catch (error) {
      // The advisory lock serializes ingestion per project, so this only fires
      // if another writer bypassed it. The unique index still holds the line.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.reports.findReport(project.id, idempotencyKey);
        if (winner !== null) {
          return this.duplicate(winner, checksum);
        }
      }
      throw error;
    }
  }

  async listReports(projectId: string): Promise<IngestionReportView[]> {
    return (await this.reports.listReports(projectId)).map(toReportView);
  }

  private async record(
    tx: PrismaTransaction,
    key: ApiKey,
    project: { id: string; key: string },
    incoming: IncomingReport,
    parsed: ParsedReport,
    checksum: string,
    idempotencyKey: string,
  ): Promise<IngestionResultView> {
    await this.reports.lockProject(project.id, tx);

    const state = await this.keys.lockForUse(key.id, tx);
    const now = new Date();
    if (
      state === null ||
      state.revokedAt !== null ||
      (state.expiresAt !== null && state.expiresAt <= now)
    ) {
      throw new UnauthenticatedError(INVALID_KEY_MESSAGE);
    }

    const winner = await this.reports.findReport(project.id, idempotencyKey, tx);
    if (winner !== null) {
      return this.duplicate(winner, checksum);
    }

    // Tests → case keys of this project only.
    const keysByTest = parsed.tests.map((test) =>
      caseKeysIn(project.key, [test.name, ...test.hints]),
    );
    const allKeys = [...new Set(keysByTest.flat())];
    const cases =
      allKeys.length === 0
        ? []
        : await this.runs.casesForSelection({ projectId: project.id, key: { in: allKeys } }, tx);
    const caseByKey = new Map(cases.map((testCase) => [testCase.key, testCase]));

    // Release: a version of this project's own releases, still open.
    const releaseId =
      incoming.query.release === undefined
        ? null
        : await this.releases.findIdByVersion(project.id, incoming.query.release, tx);
    if (releaseId !== null) {
      await this.releases.assertAttachable(releaseId, project.id, tx);
    }

    // Run: an existing open run of the same project, or a new one.
    let run =
      incoming.query.runId === undefined
        ? null
        : await this.runs.findById(incoming.query.runId, tx);
    if (incoming.query.runId !== undefined) {
      if (run === null || run.projectId !== project.id) {
        throw new NotFoundError('Test run');
      }
      if (run.status === TestRunStatus.completed || run.status === TestRunStatus.aborted) {
        throw new ConflictError(`The test run is ${run.status} and accepts no more results`);
      }
      if (releaseId !== null && run.releaseId !== releaseId) {
        throw new ConflictError('The test run does not belong to this release');
      }
    }

    const matchedCases = allKeys.filter((caseKey) => caseByKey.has(caseKey));
    if (run === null && matchedCases.length > 0) {
      run = await this.runs.create(
        {
          projectId: project.id,
          name: incoming.query.runName ?? defaultRunName(parsed, incoming.format, now),
          environment: incoming.query.environment ?? null,
          milestone: incoming.query.milestone ?? null,
          releaseId,
          status: TestRunStatus.planned,
        },
        tx,
      );
      await this.runs.addRunCases(
        matchedCases.map((caseKey, index) => {
          const testCase = caseByKey.get(caseKey)!;
          return {
            testRunId: run!.id,
            testCaseId: testCase.id,
            caseSnapshot: snapshotOf(testCase) as unknown as Prisma.InputJsonValue,
            caseVersion: testCase.version,
            position: index + 1,
          };
        }),
        tx,
      );
    }

    const runCaseByCaseId =
      run === null
        ? new Map<string, { id: string }>()
        : new Map((await this.reports.runCases(run.id, tx)).map((row) => [row.testCaseId, row]));

    // Group the tests of each case; report the rest with the reason.
    const grouped = new Map<string, ParsedTest[]>();
    const unmatched: IngestionUnmatchedView[] = [];
    let unmatchedCount = 0;
    parsed.tests.forEach((test, index) => {
      const testKeys = keysByTest[index]!;
      const reason = unmatchedReason(testKeys, caseByKey, runCaseByCaseId);
      const recordable = testKeys.filter((caseKey) => {
        const testCase = caseByKey.get(caseKey);
        return testCase !== undefined && runCaseByCaseId.has(testCase.id);
      });
      if (recordable.length === 0) {
        unmatchedCount += 1;
        if (unmatched.length < MAX_UNMATCHED_STORED) {
          unmatched.push({
            name: test.name,
            outcome: test.outcome,
            reason: reason ?? 'case_not_found',
          });
        }
        return;
      }
      for (const caseKey of recordable) {
        grouped.set(caseKey, [...(grouped.get(caseKey) ?? []), test]);
      }
    });

    const recorded: IngestionRecordedView[] = [];
    for (const [caseKey, tests] of grouped) {
      const testCase = caseByKey.get(caseKey)!;
      const runCase = runCaseByCaseId.get(testCase.id)!;
      const status = aggregate(tests);
      const elapsedSeconds = elapsedOf(tests);
      await this.runs.createResult(
        {
          testRunId: run!.id,
          testRunCaseId: runCase.id,
          status,
          comment: commentOf(tests, incoming.format, key.prefix),
          elapsedSeconds,
          executedById: null,
          executedAt: now,
        },
        tx,
      );
      await this.runs.setLatestStatus(runCase.id, status, tx);
      recorded.push({ caseKey, status, tests: tests.length, elapsedSeconds });
    }
    if (run !== null && recorded.length > 0 && run.status === TestRunStatus.planned) {
      await this.runs.update(run.id, { status: TestRunStatus.in_progress }, tx);
    }

    const summary: IngestionSummary = {
      tests: parsed.tests.length,
      passed: parsed.tests.filter((test) => test.outcome === 'passed').length,
      failed: parsed.tests.filter((test) => test.outcome === 'failed').length,
      skipped: parsed.tests.filter((test) => test.outcome === 'skipped').length,
      recorded: recorded.length,
      unmatched: unmatchedCount,
    };
    const stored: StoredSummary = { summary, recorded, unmatched };
    const report = await this.reports.createReport(
      {
        projectId: project.id,
        apiKeyId: key.id,
        format: incoming.format,
        idempotencyKey,
        checksum,
        fileName: incoming.fileName,
        fileSizeBytes: incoming.buffer.length,
        testRunId: run?.id ?? null,
        summary: stored as unknown as Prisma.InputJsonValue,
      },
      tx,
    );
    await this.keys.touch(key.id, now, tx);
    await this.audit.record(
      {
        action: AuditAction.execute,
        entityType: 'IngestionReport',
        entityId: report.id,
        summary: `Ingested ${incoming.format} report with API key qfh_${key.prefix}: ${recorded.length} case result(s), ${unmatchedCount} unmatched test(s)`,
        changes: {
          apiKeyId: key.id,
          prefix: key.prefix,
          projectId: project.id,
          testRunId: run?.id ?? null,
          checksum,
          ...summary,
        },
      },
      tx,
    );
    return { duplicate: false, report: toReportView(report) };
  }

  private idempotencyKey(header: string | undefined, checksum: string): string {
    if (header === undefined) {
      return `sha256:${checksum}`;
    }
    const parsed = idempotencyKeySchema.safeParse(header);
    if (!parsed.success) {
      throw new ValidationError('Invalid Idempotency-Key header', [
        { path: 'Idempotency-Key', message: parsed.error.issues[0]?.message ?? 'invalid' },
      ]);
    }
    return `key:${parsed.data}`;
  }

  /** A retry of the same report returns the original; a different one is a client bug. */
  private duplicate(existing: StoredReport, checksum: string): IngestionResultView {
    if (existing.checksum !== checksum) {
      throw new ConflictError(
        'This Idempotency-Key was already used for a different report; use a new key',
      );
    }
    return { duplicate: true, report: toReportView(existing) };
  }

  private async auditRejected(key: ApiKey, reason: string): Promise<void> {
    await this.audit.record({
      action: AuditAction.execute,
      entityType: 'ApiKey',
      entityId: key.id,
      summary: `Rejected use of API key qfh_${key.prefix}: ${reason}`,
      changes: { prefix: key.prefix, projectId: key.projectId, rejected: reason },
    });
  }
}

function unmatchedReason(
  testKeys: string[],
  caseByKey: Map<string, { id: string }>,
  runCaseByCaseId: Map<string, unknown>,
): IngestionUnmatchedView['reason'] | null {
  if (testKeys.length === 0) {
    return 'no_case_key';
  }
  const found = testKeys.filter((caseKey) => caseByKey.has(caseKey));
  if (found.length === 0) {
    return 'case_not_found';
  }
  return found.some((caseKey) => runCaseByCaseId.has(caseByKey.get(caseKey)!.id))
    ? null
    : 'case_not_in_run';
}

/** Several tests for one case: any failure fails it; skipped only if all are. */
function aggregate(tests: ParsedTest[]): IngestedTestOutcome {
  if (tests.some((test) => test.outcome === 'failed')) {
    return 'failed';
  }
  return tests.some((test) => test.outcome === 'passed') ? 'passed' : 'skipped';
}

function elapsedOf(tests: ParsedTest[]): number | null {
  const durations = tests.map((test) => test.durationMs).filter((ms): ms is number => ms !== null);
  if (durations.length === 0) {
    return null;
  }
  const total = durations.reduce((sum, ms) => sum + ms, 0);
  return Math.min(2_147_483_647, Math.round(total / 1000));
}

function commentOf(tests: ParsedTest[], format: IngestionFormat, prefix: string): string {
  const header = `Automated (${format}, key qfh_${prefix}): ${tests.length} test(s)`;
  const errors = tests
    .filter((test) => test.outcome === 'failed')
    .map((test) => `${test.name}: ${test.error ?? 'failed'}`);
  return truncate([header, ...errors].join('\n'), MAX_ERROR_LENGTH * 2);
}

function defaultRunName(parsed: ParsedReport, format: IngestionFormat, now: Date): string {
  const label = parsed.title ?? (format === 'junit_xml' ? 'JUnit report' : 'Playwright report');
  return truncate(`${label} — ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`, 200);
}

function toReportView(report: StoredReport): IngestionReportView {
  const stored = report.summary as unknown as StoredSummary;
  return {
    id: report.id,
    projectId: report.projectId,
    format: report.format,
    fileName: report.fileName,
    fileSizeBytes: report.fileSizeBytes,
    checksum: report.checksum,
    testRunId: report.testRunId,
    summary: stored.summary,
    recorded: stored.recorded,
    unmatched: stored.unmatched,
    apiKeyPrefix: report.apiKey === null ? null : `qfh_${report.apiKey.prefix}`,
    createdAt: report.createdAt.toISOString(),
  };
}
