import { Injectable } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import {
  ExportMatrixQuery,
  ExportTestCasesQuery,
  QAFLOW_CSV_COLUMNS,
  RunCaseSnapshot,
  encodeSectionPath,
} from '@qa-flow-hub/shared';
import { AppConfigService } from '../../config/app-config.service';
import { ExportTooLargeError, NotFoundError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { TraceabilityService } from '../traceability/traceability.service';
import { csvDocument, exportFileName } from './csv-writer';
import { EXPORT_PAGE_SIZE, ExportsRepository } from './exports.repository';

export interface CsvExport {
  fileName: string;
  body: string;
  rows: number;
}

type Cell = string | number | null;

export const RUN_EXPORT_COLUMNS = [
  'key',
  'title',
  'priority',
  'type',
  'case_version',
  'status',
  'assignee',
  'executed_by',
  'executed_at',
  'elapsed_seconds',
  'comment',
] as const;

export const MATRIX_EXPORT_COLUMNS = [
  'requirement_key',
  'requirement_title',
  'requirement_status',
  'requirement_priority',
  'covered',
  'verified',
  'case_key',
  'case_title',
  'case_last_status',
  'case_archived',
  'open_defects',
] as const;

/**
 * CSV exports. Each one is authorized by its route (`<module>.read` plus
 * `data.export`, checked against the project the data belongs to), reads only
 * the current organization through the scoped client, and is audited.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly repository: ExportsRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly traceability: TraceabilityService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  /** The qa-flow-hub template: the file imports back into the same columns. */
  async testCases(projectId: string, query: ExportTestCasesQuery): Promise<CsvExport> {
    const project = await this.projects.findById(projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);

    const max = this.config.exportMaxRows;
    const where = this.repository.caseWhere(project.id, {
      suiteId: query.suiteId,
      sectionId: query.sectionId,
      status: query.status,
      includeArchived: query.includeArchived === 'true',
    });
    const total = await this.repository.countCases(where);
    if (total > max) {
      throw new ExportTooLargeError(total, max);
    }

    const suites = await this.repository.suitesOf(project.id);
    const suiteName = new Map(suites.map((suite) => [suite.id, suite.name]));
    const sections = await this.repository.sectionsOf(suites.map((suite) => suite.id));
    const sectionById = new Map(sections.map((section) => [section.id, section]));
    const pathOf = (sectionId: string | null): string => {
      const names: string[] = [];
      let cursor = sectionId === null ? undefined : sectionById.get(sectionId);
      while (cursor !== undefined && names.length < 20) {
        names.unshift(cursor.name);
        cursor = cursor.parentId === null ? undefined : sectionById.get(cursor.parentId);
      }
      return encodeSectionPath(names);
    };

    const rows: Cell[][] = [];
    let after: string | null = null;
    for (;;) {
      const page = await this.repository.casesPage(where, after);
      if (page.length === 0) {
        break;
      }
      const references = await this.repository.requirementKeysByCase(
        page.map((testCase) => testCase.id),
      );
      for (const testCase of page) {
        const caseCells: Cell[] = [
          testCase.key,
          suiteName.get(testCase.suiteId) ?? '',
          pathOf(testCase.sectionId),
          testCase.title,
          testCase.type,
          testCase.priority,
          testCase.status,
          testCase.automationStatus,
          testCase.estimateMinutes,
          testCase.tags.join(';'),
          (references.get(testCase.id) ?? []).join(';'),
          testCase.preconditions,
          testCase.description,
          testCase.expectedResult,
        ];
        const steps = testCase.steps.length === 0 ? [null] : testCase.steps;
        steps.forEach((step, index) => {
          const fields =
            index === 0 ? caseCells : [testCase.key, ...caseCells.slice(1).map(() => null)];
          rows.push([
            ...fields,
            step?.action ?? null,
            step?.expectedResult ?? null,
            step?.data ?? null,
          ]);
        });
        if (rows.length > max) {
          throw new ExportTooLargeError(rows.length, max);
        }
      }
      after = page[page.length - 1]?.id ?? null;
      if (page.length < EXPORT_PAGE_SIZE) {
        break;
      }
    }

    await this.record('Project', project.id, `Exported ${total} test cases to CSV`);
    return {
      fileName: exportFileName(project.key, 'test-cases'),
      body: csvDocument(QAFLOW_CSV_COLUMNS, rows),
      rows: rows.length,
    };
  }

  /** What was executed: the snapshot frozen in the run, never the live case. */
  async testRun(id: string): Promise<CsvExport> {
    const run = await this.repository.findRun(id);
    if (run === null) {
      throw new NotFoundError('Test run');
    }
    await this.access.assertRouteAccess(run.projectId, 'Test run');

    const max = this.config.exportMaxRows;
    const total = await this.repository.countRunCases(run.id);
    if (total > max) {
      throw new ExportTooLargeError(total, max);
    }
    const runCases = await this.repository.runCases(run.id);
    const latest = await this.repository.latestResults(runCases.map((runCase) => runCase.id));
    const userIds = new Set<string>();
    for (const runCase of runCases) {
      if (runCase.assignedToId !== null) userIds.add(runCase.assignedToId);
      const executedBy = latest.get(runCase.id)?.executedById;
      if (executedBy !== undefined && executedBy !== null) userIds.add(executedBy);
    }
    const names = await this.repository.memberNames([...userIds]);

    const rows: Cell[][] = runCases.map((runCase) => {
      const snapshot = runCase.caseSnapshot as unknown as RunCaseSnapshot;
      const result = latest.get(runCase.id);
      return [
        snapshot.key,
        snapshot.title,
        snapshot.priority,
        snapshot.type,
        runCase.caseVersion,
        runCase.latestStatus,
        runCase.assignedToId === null ? null : (names.get(runCase.assignedToId) ?? null),
        result?.executedById == null ? null : (names.get(result.executedById) ?? null),
        result?.executedAt.toISOString() ?? null,
        result?.elapsedSeconds ?? null,
        result?.comment ?? null,
      ];
    });

    await this.record('TestRun', run.id, `Exported run ${run.name} (${rows.length} cases) to CSV`);
    return {
      fileName: exportFileName(run.name, 'run'),
      body: csvDocument(RUN_EXPORT_COLUMNS, rows),
      rows: rows.length,
    };
  }

  /** The same matrix the screen shows, flattened to one row per requirement and case. */
  async matrix(query: ExportMatrixQuery): Promise<CsvExport> {
    const matrix = await this.traceability.matrix(query);
    const project = await this.projects.findById(matrix.projectId);
    const rows: Cell[][] = [];
    for (const row of matrix.rows) {
      const requirementCells: Cell[] = [
        row.key,
        row.title,
        row.status,
        row.priority,
        row.covered ? 'yes' : 'no',
        row.verified ? 'yes' : 'no',
      ];
      if (row.cases.length === 0) {
        rows.push([...requirementCells, null, null, null, null, row.defectIds.length]);
      }
      for (const testCase of row.cases) {
        rows.push([
          ...requirementCells,
          testCase.key,
          testCase.title,
          testCase.lastStatus,
          testCase.archived ? 'yes' : 'no',
          row.defectIds.length,
        ]);
      }
    }
    if (rows.length > this.config.exportMaxRows) {
      throw new ExportTooLargeError(rows.length, this.config.exportMaxRows);
    }

    await this.record(
      'Project',
      matrix.projectId,
      `Exported the traceability matrix (${matrix.rows.length} requirements) to CSV`,
    );
    return {
      fileName: exportFileName(project?.key ?? 'project', 'traceability-matrix'),
      body: csvDocument(MATRIX_EXPORT_COLUMNS, rows),
      rows: rows.length,
    };
  }

  private async record(entityType: string, entityId: string, summary: string): Promise<void> {
    await this.audit.record({ action: AuditAction.export, entityType, entityId, summary });
  }
}
