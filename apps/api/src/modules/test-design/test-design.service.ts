import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma, TestCase, TestSection, TestStep, TestSuite } from '@prisma/client';
import {
  CreateSectionInput,
  CreateSuiteInput,
  CreateTestCaseInput,
  DuplicateTestCaseInput,
  ListTestCasesQuery,
  Paginated,
  ReplaceStepsInput,
  SectionView,
  SuiteView,
  TestCaseDetailView,
  TestCaseView,
  TestStepView,
  UpdateSectionInput,
  UpdateSuiteInput,
  UpdateTestCaseInput,
  buildPaginationMeta,
  DATASET_ID_COLUMN,
  DATASET_LABEL_COLUMN,
  DatasetRowView,
  ImportDatasetInput,
  ReplaceParametersInput,
  TestParameterView,
  formatParameterValue,
  parseParameterCell,
  validateParameterDefinition,
  RestoreVersionInput,
  TestCaseVersionContent,
  TestCaseVersionSummaryView,
  TestCaseVersionView,
  VersionDiffQuery,
  VersionDiffView,
  VersionStepView,
  diffVersionContent,
} from '@qa-flow-hub/shared';
import { randomBytes } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { csvDocument } from '../exports/csv-writer';
import type { CsvExport } from '../exports/exports.service';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import {
  ConflictError,
  DuplicateResourceError,
  NotFoundError,
  ValidationError,
} from '../../errors';
import { AuditService } from '../audit/audit.service';
import {
  CustomFieldValuesService,
  customFieldWhere,
  storedValues,
} from '../customization/custom-field-values.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { TraceabilityLinksRepository } from '../traceability/traceability-links.repository';
import { TestDesignRepository, VersionWithAuthor } from './test-design.repository';

/**
 * Sections nest, and every level costs a query when the tree is walked. Five is
 * deeper than any test plan needs and shallow enough to keep the tree cheap.
 */
const MAX_SECTION_DEPTH = 5;

@Injectable()
export class TestDesignService {
  constructor(
    private readonly repository: TestDesignRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly links: TraceabilityLinksRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly customValues: CustomFieldValuesService,
  ) {}

  // --- Suites --------------------------------------------------------------

  async createSuite(input: CreateSuiteInput): Promise<SuiteView> {
    const project = await this.projects.findById(input.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);
    if ((await this.repository.findSuiteByName(project.id, input.name)) !== null) {
      throw new DuplicateResourceError('test suite', 'name');
    }

    const suite = await this.repository.createSuite({
      projectId: project.id,
      name: input.name,
      ...(input.description === undefined || input.description === null
        ? {}
        : { description: input.description }),
    });

    await this.audit.record({
      action: AuditAction.create,
      entityType: 'TestSuite',
      entityId: suite.id,
      summary: `Created suite ${suite.name}`,
    });

    return toSuiteView(suite, 0);
  }

  async listSuites(projectId: string | undefined): Promise<SuiteView[]> {
    if (projectId === undefined || projectId === '') {
      throw new ValidationError('projectId is required');
    }
    const visibleProjectId = await this.authorizedProject(projectId);
    if (visibleProjectId === null) {
      return [];
    }
    const suites = await this.repository.listSuites(visibleProjectId);
    return suites.map((suite) => toSuiteView(suite, suite._count.testCases));
  }

  async updateSuite(id: string, input: UpdateSuiteInput): Promise<SuiteView> {
    const suite = await this.requireSuite(id);

    if (input.name !== undefined && input.name !== suite.name) {
      const clash = await this.repository.findSuiteByName(suite.projectId, input.name);
      if (clash !== null) {
        throw new DuplicateResourceError('test suite', 'name');
      }
    }

    const updated = await this.repository.updateSuite(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.position === undefined ? {} : { position: input.position }),
    });
    if (updated === null) {
      throw new NotFoundError('Test suite');
    }

    await this.audit.record({
      action: AuditAction.update,
      entityType: 'TestSuite',
      entityId: id,
      summary: `Updated suite ${updated.name}`,
    });

    return toSuiteView(updated, await this.repository.countCasesInSuite(id));
  }

  async deleteSuite(id: string): Promise<void> {
    const suite = await this.requireSuite(id);

    await this.prisma.runInTransaction(async (tx) => {
      const caseIds = await this.repository.softDeleteSuite(id, tx);
      if (caseIds === null) {
        throw new NotFoundError('Test suite');
      }

      // The cases went with the suite, so their links have to go too. A suite
      // is not linkable itself, which is why only the cases are purged.
      const purged = await this.links.purgeFor('test_case', caseIds, tx);

      await this.audit.record(
        {
          action: AuditAction.delete,
          entityType: 'TestSuite',
          entityId: id,
          summary: `Deleted suite ${suite.name} and its cases`,
          changes: {
            removedCases: caseIds.length,
            ...(purged === 0 ? {} : { removedTraceabilityLinks: purged }),
          },
        },
        tx,
      );
    });
  }

  // --- Sections ------------------------------------------------------------

  async createSection(input: CreateSectionInput): Promise<SectionView> {
    const suite = await this.requireSuite(input.suiteId);

    let depth = 0;
    if (input.parentId !== undefined && input.parentId !== null) {
      const parent = await this.repository.findSectionById(input.parentId);
      if (parent === null || parent.suiteId !== suite.id) {
        throw new ValidationError('The parent section does not belong to this suite');
      }
      depth = (await this.depthOf(parent)) + 1;
      if (depth >= MAX_SECTION_DEPTH) {
        throw new ConflictError(`Sections cannot nest deeper than ${MAX_SECTION_DEPTH} levels`);
      }
    }

    const section = await this.repository.createSection({
      suiteId: suite.id,
      parentId: input.parentId ?? null,
      name: input.name,
      ...(input.description === undefined || input.description === null
        ? {}
        : { description: input.description }),
    });

    return toSectionView(section, []);
  }

  /** The whole tree of a suite, built in memory from a single query. */
  async sectionTree(suiteId: string): Promise<SectionView[]> {
    await this.requireSuite(suiteId);
    const sections = await this.repository.listSections(suiteId);

    const views = new Map<string, SectionView>(
      sections.map((section) => [section.id, toSectionView(section, [])]),
    );
    const roots: SectionView[] = [];

    for (const section of sections) {
      const view = views.get(section.id);
      if (view === undefined) {
        continue;
      }
      const parent = section.parentId === null ? undefined : views.get(section.parentId);
      if (parent === undefined) {
        roots.push(view);
      } else {
        parent.children.push(view);
      }
    }

    return roots;
  }

  async updateSection(id: string, input: UpdateSectionInput): Promise<SectionView> {
    const section = await this.requireSection(id);

    if (input.parentId !== undefined) {
      await this.assertReparentable(section, input.parentId);
    }

    const updated = await this.repository.updateSection(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.position === undefined ? {} : { position: input.position }),
      ...(input.parentId === undefined
        ? {}
        : input.parentId === null
          ? { parent: { disconnect: true } }
          : { parent: { connect: { id: input.parentId } } }),
    });
    if (updated === null) {
      throw new NotFoundError('Test section');
    }

    return toSectionView(updated, []);
  }

  /**
   * Deleting a folder deletes the folder, not the work inside it: descendant
   * sections go too, but their cases move to the suite root.
   */
  async deleteSection(id: string): Promise<void> {
    const section = await this.requireSection(id);
    const ids = await this.descendantIds(section);

    await this.prisma.runInTransaction(async (tx) => {
      await this.repository.softDeleteSections(ids, tx);
      await this.audit.record(
        {
          action: AuditAction.delete,
          entityType: 'TestSection',
          entityId: id,
          summary: `Deleted section ${section.name}`,
          changes: { removedSections: ids.length },
        },
        tx,
      );
    });
  }

  // --- Cases ---------------------------------------------------------------

  async createCase(input: CreateTestCaseInput, userId: string): Promise<TestCaseDetailView> {
    const suite = await this.requireSuite(input.suiteId);
    const sectionId = await this.resolveSectionId(suite.id, input.sectionId);

    const created = await this.prisma.runInTransaction(async (tx) => {
      const customFields = await this.customValues.resolve(
        suite.projectId,
        'test_case',
        input.customFields,
        null,
        tx,
      );
      const key = await this.projects.nextKey(suite.projectId, 'testCaseCounter', 'C', tx);

      const testCase = await this.repository.createCase(
        {
          projectId: suite.projectId,
          suiteId: suite.id,
          sectionId,
          key,
          title: input.title,
          ...optionalText('description', input.description),
          ...optionalText('preconditions', input.preconditions),
          ...optionalText('expectedResult', input.expectedResult),
          type: input.type,
          priority: input.priority,
          automationStatus: input.automationStatus,
          ...(input.estimateMinutes === undefined || input.estimateMinutes === null
            ? {}
            : { estimateMinutes: input.estimateMinutes }),
          tags: input.tags,
          customFields: customFields,
          createdById: userId,
        },
        tx,
      );

      await this.repository.replaceSteps(testCase.id, input.steps, tx);
      await this.repository.appendVersion(testCase.id, { authorId: userId }, tx);

      await this.audit.record(
        {
          action: AuditAction.create,
          entityType: 'TestCase',
          entityId: testCase.id,
          summary: `Created ${testCase.key} — ${testCase.title}`,
        },
        tx,
      );

      return testCase;
    });

    return this.detail(created.id);
  }

  async listCases(query: ListTestCasesQuery): Promise<Paginated<TestCaseView>> {
    const projectId = await this.authorizedProject(query.projectId);
    if (projectId === null) {
      return { data: [], meta: buildPaginationMeta(query, 0) };
    }
    const customFilter = customFieldWhere(
      await this.customValues.filter(projectId, 'test_case', query),
    );
    const page = await this.repository.listCases(query, {
      projectId,
      ...customFilter,
      includeArchived: query.includeArchived === 'true',
      ...(query.suiteId === undefined ? {} : { suiteId: query.suiteId }),
      ...(query.sectionId === undefined ? {} : { sectionId: query.sectionId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.priority === undefined ? {} : { priority: query.priority }),
      ...(query.automationStatus === undefined ? {} : { automationStatus: query.automationStatus }),
      ...(query.tag === undefined ? {} : { tag: query.tag }),
      ...(query.search === undefined ? {} : { search: query.search }),
    });

    return { data: page.data.map(toTestCaseView), meta: page.meta };
  }

  async getCase(id: string): Promise<TestCaseDetailView> {
    await this.requireCase(id);
    return this.detail(id);
  }

  /**
   * Edits a case. Only content (title, description, preconditions, expected
   * result, type, priority, steps) creates a version; bookkeeping fields such
   * as status, tags or section change in place. The case row is locked, and
   * `version` makes a stale editor fail with 409 instead of overwriting.
   */
  async updateCase(
    id: string,
    input: UpdateTestCaseInput,
    userId: string | null = null,
  ): Promise<TestCaseDetailView> {
    const testCase = await this.requireCase(id);
    this.assertEditable(testCase);

    const sectionId =
      input.sectionId === undefined
        ? undefined
        : await this.resolveSectionId(testCase.suiteId, input.sectionId);

    // One save is one version, fields and steps included: `version` lands in
    // run snapshots, so two bumps per edit would make a report cite a version
    // nobody ever saw.
    await this.prisma.runInTransaction(async (tx) => {
      const locked = await this.lockEditable(id, input.version, tx);
      const customFields =
        input.customFields === undefined
          ? undefined
          : await this.customValues.resolve(
              locked.projectId,
              'test_case',
              input.customFields,
              await this.repository.lockCustomFields(id, tx),
              tx,
            );
      const stepsChanged =
        input.steps !== undefined &&
        !sameSteps(await this.repository.listSteps(id, tx), input.steps);
      const contentChanged =
        stepsChanged ||
        changed(input.title, locked.title) ||
        changed(input.description, locked.description) ||
        changed(input.preconditions, locked.preconditions) ||
        changed(input.expectedResult, locked.expectedResult) ||
        changed(input.type, locked.type) ||
        changed(input.priority, locked.priority);
      const testCaseAfter = await this.repository.updateCase(
        id,
        {
          ...(customFields === undefined ? {} : { customFields: customFields }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.preconditions === undefined ? {} : { preconditions: input.preconditions }),
          ...(input.expectedResult === undefined ? {} : { expectedResult: input.expectedResult }),
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.automationStatus === undefined
            ? {}
            : { automationStatus: input.automationStatus }),
          ...(input.estimateMinutes === undefined
            ? {}
            : { estimateMinutes: input.estimateMinutes }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(sectionId === undefined ? {} : { sectionId }),
          ...(contentChanged ? { version: { increment: 1 } } : {}),
        },
        tx,
      );
      if (testCaseAfter === null) {
        throw new NotFoundError('Test case');
      }

      if (stepsChanged && input.steps !== undefined) {
        await this.repository.replaceSteps(id, input.steps, tx);
      }
      if (contentChanged) {
        await this.repository.appendVersion(
          id,
          { authorId: userId, changeReason: input.changeReason ?? null },
          tx,
        );
      }

      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'TestCase',
          entityId: id,
          summary: contentChanged
            ? `Updated ${testCaseAfter.key} to version ${testCaseAfter.version}`
            : `Updated ${testCaseAfter.key} (version ${testCaseAfter.version} unchanged)`,
          changes: {
            version: testCaseAfter.version,
            newVersion: contentChanged,
            ...(input.steps === undefined ? {} : { steps: input.steps.length }),
            ...(input.changeReason === undefined ? {} : { reason: input.changeReason }),
          },
        },
        tx,
      );
    });

    return this.detail(id);
  }

  async replaceSteps(
    id: string,
    input: ReplaceStepsInput,
    userId: string | null = null,
  ): Promise<TestCaseDetailView> {
    const testCase = await this.requireCase(id);
    this.assertEditable(testCase);

    await this.prisma.runInTransaction(async (tx) => {
      await this.lockEditable(id, input.version, tx);
      if (sameSteps(await this.repository.listSteps(id, tx), input.steps)) {
        return;
      }
      await this.repository.replaceSteps(id, input.steps, tx);
      const after = await this.repository.updateCase(id, { version: { increment: 1 } }, tx);
      await this.repository.appendVersion(
        id,
        { authorId: userId, changeReason: input.changeReason ?? null },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'TestCase',
          entityId: id,
          summary: `Rewrote the steps of ${testCase.key}, version ${after?.version ?? '?'}`,
          changes: { steps: input.steps.length },
        },
        tx,
      );
    });

    return this.detail(id);
  }

  // --- Versions (S7-F4) ----------------------------------------------------

  async listVersions(id: string): Promise<TestCaseVersionSummaryView[]> {
    const testCase = await this.requireCase(id);
    const rows = await this.repository.listVersions(id);
    return rows.map((row) => toVersionSummary(row, testCase.version));
  }

  async getVersion(id: string, version: number): Promise<TestCaseVersionView> {
    const testCase = await this.requireCase(id);
    const row = await this.requireVersion(id, version);
    return { ...toVersionSummary(row, testCase.version), content: versionContent(row) };
  }

  async diffVersions(id: string, query: VersionDiffQuery): Promise<VersionDiffView> {
    await this.requireCase(id);
    const [from, to] = await Promise.all([
      this.requireVersion(id, query.from),
      this.requireVersion(id, query.to),
    ]);
    return {
      testCaseId: id,
      from: from.version,
      to: to.version,
      ...diffVersionContent(versionContent(from), versionContent(to)),
    };
  }

  /**
   * Restoring copies an older version into a new one. History is never
   * rewritten: the restored content gets the next number and remembers where
   * it came from.
   */
  async restoreVersion(
    id: string,
    version: number,
    input: RestoreVersionInput,
    userId: string | null = null,
  ): Promise<TestCaseDetailView> {
    const testCase = await this.requireCase(id);
    this.assertEditable(testCase);

    await this.prisma.runInTransaction(async (tx) => {
      const locked = await this.lockEditable(id, input.version, tx);
      const target = await this.repository.findVersion(id, version, tx);
      if (target === null) {
        throw new NotFoundError('Test case version');
      }
      if (target.version === locked.version) {
        throw new ConflictError(`Version ${version} is already the current version`);
      }
      const content = versionContent(target);
      const after = await this.repository.updateCase(
        id,
        {
          title: content.title,
          description: content.description,
          preconditions: content.preconditions,
          expectedResult: content.expectedResult,
          type: target.type,
          priority: target.priority,
          parameters: content.parameters as unknown as Prisma.InputJsonValue,
          dataset: content.dataset as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
        tx,
      );
      if (after === null) {
        throw new NotFoundError('Test case');
      }
      await this.repository.replaceSteps(id, content.steps, tx);
      await this.repository.appendVersion(
        id,
        {
          authorId: userId,
          changeReason: input.reason ?? `Restored version ${version}`,
          restoredFromVersion: version,
        },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.restore,
          entityType: 'TestCase',
          entityId: id,
          summary: `Restored ${after.key} version ${version} as version ${after.version}`,
          changes: {
            restoredFromVersion: version,
            version: after.version,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
        },
        tx,
      );
    });

    return this.detail(id);
  }

  // --- Parameters and dataset (S7-F3) --------------------------------------

  /**
   * Replaces the parameters and the dataset as one definition, bumping the case
   * version. Runs already created keep the values they froze, so this never
   * rewrites an execution; `version` makes a stale editor fail with 409.
   */
  async replaceParameters(
    id: string,
    input: ReplaceParametersInput,
    userId: string | null = null,
  ): Promise<TestCaseDetailView> {
    const testCase = await this.requireCase(id);
    this.assertEditable(testCase);
    const errors = validateParameterDefinition(input.parameters, input.rows);
    if (errors.length > 0) {
      throw new ValidationError(errors.join('; '));
    }

    await this.prisma.runInTransaction(async (tx) => {
      const locked = await this.repository.lockCase(id, tx);
      if (locked === null) {
        throw new NotFoundError('Test case');
      }
      this.assertEditable(locked);
      if (input.version !== undefined && input.version !== locked.version) {
        throw new ConflictError(
          `Test case ${locked.key} changed (version ${locked.version}); reload and retry`,
        );
      }
      const parameters: TestParameterView[] = input.parameters.map((parameter) => ({
        name: parameter.name,
        type: parameter.type,
        required: parameter.required,
        defaultValue: parameter.defaultValue ?? null,
        description: parameter.description ?? null,
      }));
      const dataset: DatasetRowView[] = input.rows.map((row, index) => ({
        id: row.id ?? `r${randomBytes(6).toString('hex')}`,
        label: row.label ?? `Row ${index + 1}`,
        values: Object.fromEntries(
          parameters.map((parameter) => {
            const key = Object.keys(row.values).find(
              (name) => name.toLowerCase() === parameter.name.toLowerCase(),
            );
            const value = key === undefined ? null : (row.values[key] ?? null);
            return [parameter.name, value === '' ? null : value];
          }),
        ),
      }));
      const after = await this.repository.updateCase(
        id,
        {
          parameters: parameters as unknown as Prisma.InputJsonValue,
          dataset: dataset as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
        tx,
      );
      if (after === null) {
        throw new NotFoundError('Test case');
      }
      await this.repository.appendVersion(
        id,
        { authorId: userId, changeReason: input.changeReason ?? null },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'TestCase',
          entityId: id,
          summary: `Set ${parameters.length} parameter(s) and ${dataset.length} dataset row(s) on ${after.key}, version ${after.version}`,
          changes: {
            parameters: parameters.map((parameter) => parameter.name),
            rows: dataset.length,
          },
        },
        tx,
      );
    });

    return this.detail(id);
  }

  /** The dataset as CSV: `_id`, `_label` and one column per parameter. */
  async exportDataset(id: string): Promise<CsvExport> {
    const testCase = await this.requireCase(id);
    const parameters = parametersOf(testCase);
    const dataset = datasetOf(testCase);
    await this.audit.record({
      action: AuditAction.export,
      entityType: 'TestCase',
      entityId: id,
      summary: `Exported the dataset of ${testCase.key} (${dataset.length} rows)`,
    });
    return {
      fileName: `${testCase.key}-dataset.csv`,
      rows: dataset.length,
      body: csvDocument(
        [DATASET_ID_COLUMN, DATASET_LABEL_COLUMN, ...parameters.map((parameter) => parameter.name)],
        dataset.map((row) => [
          row.id,
          row.label,
          ...parameters.map((parameter) =>
            formatParameterValue(row.values[parameter.name] ?? null),
          ),
        ]),
      ),
    };
  }

  /**
   * Replaces the dataset with the rows of a CSV, typed by the case parameters.
   * Every cell is checked before anything is written: one bad cell rejects the
   * whole file with the line that caused it.
   */
  async importDataset(
    id: string,
    input: ImportDatasetInput,
    userId: string | null = null,
  ): Promise<TestCaseDetailView> {
    const testCase = await this.requireCase(id);
    const parameters = parametersOf(testCase);
    if (parameters.length === 0) {
      throw new ValidationError('Define the parameters before importing a dataset');
    }
    let records: string[][];
    try {
      records = parse(input.csv.replace(/^\uFEFF/, ''), {
        bom: true,
        skip_empty_lines: true,
        relax_column_count: false,
      });
    } catch (cause) {
      throw new ValidationError(
        `The CSV cannot be read: ${cause instanceof Error ? cause.message : 'invalid file'}`,
      );
    }
    const [header, ...body] = records;
    if (header === undefined) {
      throw new ValidationError('The CSV has no header');
    }
    const byName = new Map(
      parameters.map((parameter) => [parameter.name.toLowerCase(), parameter]),
    );
    const errors: string[] = [];
    const columns = header.map((name) => name.trim());
    for (const name of columns) {
      if (
        name !== DATASET_ID_COLUMN &&
        name !== DATASET_LABEL_COLUMN &&
        !byName.has(name.toLowerCase())
      ) {
        errors.push(`Unknown column ${name}`);
      }
    }
    const rows = body.map((cells, index) => {
      const row: {
        id?: string;
        label?: string;
        values: Record<string, string | number | boolean | null>;
      } = {
        values: {},
      };
      columns.forEach((name, column) => {
        const text = cells[column] ?? '';
        if (name === DATASET_ID_COLUMN) {
          if (text.trim() !== '') {
            row.id = text.trim();
          }
        } else if (name === DATASET_LABEL_COLUMN) {
          if (text.trim() !== '') {
            row.label = text.trim();
          }
        } else {
          const parameter = byName.get(name.toLowerCase());
          if (parameter !== undefined) {
            const parsed = parseParameterCell(parameter.type, text);
            if ('error' in parsed) {
              errors.push(`Line ${index + 2}: ${parameter.name} ${parsed.error}`);
            } else {
              row.values[parameter.name] = parsed.value;
            }
          }
        }
      });
      if (row.id !== undefined && !/^[A-Za-z0-9_-]{1,40}$/.test(row.id)) {
        errors.push(`Line ${index + 2}: invalid row id`);
      }
      return row;
    });
    if (errors.length > 0) {
      throw new ValidationError(errors.join('; '));
    }
    return this.replaceParameters(
      id,
      {
        parameters: parameters.map((parameter) => ({
          ...parameter,
          defaultValue: parameter.defaultValue,
        })),
        rows,
        ...(input.version === undefined ? {} : { version: input.version }),
        changeReason: input.changeReason ?? 'Imported the dataset from CSV',
      },
      userId,
    );
  }

  /**
   * Copies the case and its steps into a new case with a new key, starting at
   * version 1 and status `draft`. Duplication is how a real team writes the
   * fourth variant of a login test.
   */
  async duplicateCase(
    id: string,
    input: DuplicateTestCaseInput,
    userId: string,
  ): Promise<TestCaseDetailView> {
    const source = await this.repository.findCaseWithSteps(id);
    if (source === null) {
      throw new NotFoundError('Test case');
    }
    await this.access.assertRouteAccess(source.projectId, 'Test case');

    const sectionId =
      input.sectionId === undefined
        ? source.sectionId
        : await this.resolveSectionId(source.suiteId, input.sectionId);

    const copy = await this.prisma.runInTransaction(async (tx) => {
      const key = await this.projects.nextKey(source.projectId, 'testCaseCounter', 'C', tx);

      const created = await this.repository.createCase(
        {
          projectId: source.projectId,
          suiteId: source.suiteId,
          sectionId,
          key,
          title: input.title ?? `${source.title} (copy)`,
          description: source.description,
          preconditions: source.preconditions,
          expectedResult: source.expectedResult,
          type: source.type,
          priority: source.priority,
          automationStatus: source.automationStatus,
          estimateMinutes: source.estimateMinutes,
          tags: source.tags,
          customFields: source.customFields as Prisma.InputJsonValue,
          createdById: userId,
        },
        tx,
      );

      await this.repository.replaceSteps(created.id, source.steps, tx);
      await this.repository.appendVersion(
        created.id,
        { authorId: userId, changeReason: `Duplicated from ${source.key}` },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.create,
          entityType: 'TestCase',
          entityId: created.id,
          summary: `Duplicated ${source.key} as ${created.key}`,
        },
        tx,
      );

      return created;
    });

    return this.detail(copy.id);
  }

  async archiveCase(id: string): Promise<TestCaseDetailView> {
    const testCase = await this.requireCase(id);
    if (testCase.archivedAt !== null) {
      throw new ConflictError('This test case is already archived');
    }

    await this.repository.updateCase(id, { archivedAt: new Date(), status: 'deprecated' });
    await this.audit.record({
      action: AuditAction.archive,
      entityType: 'TestCase',
      entityId: id,
      summary: `Archived ${testCase.key}`,
    });

    return this.detail(id);
  }

  async restoreCase(id: string): Promise<TestCaseDetailView> {
    const testCase = await this.requireCase(id);
    if (testCase.archivedAt === null) {
      throw new ConflictError('This test case is not archived');
    }

    await this.repository.updateCase(id, { archivedAt: null, status: 'active' });
    await this.audit.record({
      action: AuditAction.restore,
      entityType: 'TestCase',
      entityId: id,
      summary: `Restored ${testCase.key}`,
    });

    return this.detail(id);
  }

  async deleteCase(id: string): Promise<void> {
    const testCase = await this.requireCase(id);

    await this.prisma.runInTransaction(async (tx) => {
      if (!(await this.repository.softDeleteCase(id, tx))) {
        throw new NotFoundError('Test case');
      }

      // Deleting is not archiving: an archived case keeps its links because it
      // can come back, a deleted one cannot.
      const purged = await this.links.purgeFor('test_case', [id], tx);

      await this.audit.record(
        {
          action: AuditAction.delete,
          entityType: 'TestCase',
          entityId: id,
          summary: `Deleted ${testCase.key}`,
          ...(purged === 0 ? {} : { changes: { removedTraceabilityLinks: purged } }),
        },
        tx,
      );
    });
  }

  // --- Internals -----------------------------------------------------------

  private async detail(id: string): Promise<TestCaseDetailView> {
    const testCase = await this.repository.findCaseWithSteps(id);
    if (testCase === null) {
      throw new NotFoundError('Test case');
    }
    return {
      ...toTestCaseView(testCase),
      steps: testCase.steps.map(toStepView),
      parameters: parametersOf(testCase),
      dataset: datasetOf(testCase),
    };
  }

  /** Locks the case row and checks the version the editor loaded. */
  private async lockEditable(
    id: string,
    expectedVersion: number | undefined,
    tx: PrismaTransaction,
  ): Promise<TestCase> {
    const locked = await this.repository.lockCase(id, tx);
    if (locked === null) {
      throw new NotFoundError('Test case');
    }
    this.assertEditable(locked);
    if (expectedVersion !== undefined && expectedVersion !== locked.version) {
      throw new ConflictError(
        `Test case ${locked.key} changed (version ${locked.version}); reload and retry`,
      );
    }
    return locked;
  }

  private async requireVersion(id: string, version: number): Promise<VersionWithAuthor> {
    const row = await this.repository.findVersion(id, version);
    if (row === null) {
      throw new NotFoundError('Test case version');
    }
    return row;
  }

  private assertEditable(testCase: TestCase): void {
    if (testCase.archivedAt !== null) {
      throw new ConflictError('An archived test case is read-only. Restore it first.');
    }
  }

  /** `null` for a project that does not exist or is not visible: the list is empty. */
  private authorizedProject(projectId: string): Promise<string | null> {
    return this.access.authorizeProjectScope(projectId);
  }

  private async requireSuite(id: string): Promise<TestSuite> {
    const suite = await this.repository.findSuiteById(id);
    if (suite === null) {
      throw new NotFoundError('Test suite');
    }
    await this.access.assertRouteAccess(suite.projectId, 'Test suite');
    return suite;
  }

  private async requireSection(id: string): Promise<TestSection> {
    const section = await this.repository.findSectionById(id);
    if (section === null) {
      throw new NotFoundError('Test section');
    }
    // A section has no project of its own; its suite is what places it in one,
    // and loading the suite is also what proves the section is reachable.
    await this.requireSuite(section.suiteId);
    return section;
  }

  private async requireCase(id: string): Promise<TestCase> {
    const testCase = await this.repository.findCaseById(id);
    if (testCase === null) {
      throw new NotFoundError('Test case');
    }
    await this.access.assertRouteAccess(testCase.projectId, 'Test case');
    return testCase;
  }

  /** A case can only sit in a section of its own suite. */
  private async resolveSectionId(
    suiteId: string,
    sectionId: string | null | undefined,
  ): Promise<string | null> {
    if (sectionId === undefined || sectionId === null) {
      return null;
    }
    const section = await this.repository.findSectionById(sectionId);
    if (section === null || section.suiteId !== suiteId) {
      throw new ValidationError('The section does not belong to this suite');
    }
    return section.id;
  }

  private async depthOf(section: TestSection): Promise<number> {
    let depth = 0;
    let current: TestSection | null = section;

    while (current !== null && current.parentId !== null) {
      current = await this.repository.findSectionById(current.parentId);
      depth += 1;
      if (depth > MAX_SECTION_DEPTH) {
        break;
      }
    }
    return depth;
  }

  /**
   * Moving a section under its own descendant would detach the whole branch
   * from the tree: it would still exist, but no root would reach it.
   */
  private async assertReparentable(section: TestSection, parentId: string | null): Promise<void> {
    if (parentId === null) {
      return;
    }
    if (parentId === section.id) {
      throw new ValidationError('A section cannot be its own parent');
    }

    const parent = await this.repository.findSectionById(parentId);
    if (parent === null || parent.suiteId !== section.suiteId) {
      throw new ValidationError('The parent section does not belong to this suite');
    }
    if ((await this.descendantIds(section)).includes(parentId)) {
      throw new ValidationError('A section cannot be moved inside one of its own descendants');
    }
  }

  private async descendantIds(section: TestSection): Promise<string[]> {
    const all = await this.repository.listSections(section.suiteId);
    const ids = [section.id];

    for (let index = 0; index < ids.length; index += 1) {
      for (const candidate of all) {
        if (candidate.parentId === ids[index] && !ids.includes(candidate.id)) {
          ids.push(candidate.id);
        }
      }
    }
    return ids;
  }
}

function optionalText<K extends string>(
  key: K,
  value: string | null | undefined,
): Record<K, string> | Record<string, never> {
  return value === undefined || value === null ? {} : ({ [key]: value } as Record<K, string>);
}

function toSuiteView(suite: TestSuite, caseCount: number): SuiteView {
  return {
    id: suite.id,
    projectId: suite.projectId,
    name: suite.name,
    description: suite.description,
    position: suite.position,
    caseCount,
    createdAt: suite.createdAt.toISOString(),
    updatedAt: suite.updatedAt.toISOString(),
  };
}

function toSectionView(section: TestSection, children: SectionView[]): SectionView {
  return {
    id: section.id,
    suiteId: section.suiteId,
    parentId: section.parentId,
    name: section.name,
    description: section.description,
    position: section.position,
    children,
  };
}

export function toTestCaseView(testCase: TestCase): TestCaseView {
  return {
    id: testCase.id,
    projectId: testCase.projectId,
    suiteId: testCase.suiteId,
    sectionId: testCase.sectionId,
    key: testCase.key,
    title: testCase.title,
    description: testCase.description,
    preconditions: testCase.preconditions,
    expectedResult: testCase.expectedResult,
    type: testCase.type,
    priority: testCase.priority,
    status: testCase.status,
    automationStatus: testCase.automationStatus,
    estimateMinutes: testCase.estimateMinutes,
    tags: testCase.tags,
    version: testCase.version,
    customFields: storedValues(testCase.customFields),
    archivedAt: testCase.archivedAt?.toISOString() ?? null,
    createdById: testCase.createdById,
    createdAt: testCase.createdAt.toISOString(),
    updatedAt: testCase.updatedAt.toISOString(),
  };
}

function toStepView(step: TestStep): TestStepView {
  return {
    id: step.id,
    position: step.position,
    action: step.action,
    expectedResult: step.expectedResult,
    data: step.data,
  };
}

export function parametersOf(testCase: Pick<TestCase, 'parameters'>): TestParameterView[] {
  return Array.isArray(testCase.parameters)
    ? (testCase.parameters as unknown as TestParameterView[])
    : [];
}

export function datasetOf(testCase: Pick<TestCase, 'dataset'>): DatasetRowView[] {
  return Array.isArray(testCase.dataset) ? (testCase.dataset as unknown as DatasetRowView[]) : [];
}

/** `undefined` leaves a field alone; anything else is a change if it differs. */
function changed<T>(next: T | null | undefined, current: T | null): boolean {
  return next !== undefined && (next ?? null) !== current;
}

function sameSteps(
  current: ReadonlyArray<Pick<TestStep, 'action' | 'expectedResult' | 'data'>>,
  next: ReadonlyArray<{
    action: string;
    expectedResult?: string | null | undefined;
    data?: string | null | undefined;
  }>,
): boolean {
  return (
    current.length === next.length &&
    current.every(
      (step, index) =>
        step.action === next[index]!.action &&
        step.expectedResult === (next[index]!.expectedResult ?? null) &&
        step.data === (next[index]!.data ?? null),
    )
  );
}

function toVersionSummary(
  row: VersionWithAuthor,
  currentVersion: number,
): TestCaseVersionSummaryView {
  return {
    id: row.id,
    testCaseId: row.testCaseId,
    version: row.version,
    current: row.version === currentVersion,
    changeReason: row.changeReason,
    restoredFromVersion: row.restoredFromVersion,
    author: row.author,
    createdAt: row.createdAt.toISOString(),
  };
}

function versionContent(row: VersionWithAuthor): TestCaseVersionContent {
  const steps = Array.isArray(row.steps) ? (row.steps as unknown as VersionStepView[]) : [];
  return {
    title: row.title,
    description: row.description,
    preconditions: row.preconditions,
    expectedResult: row.expectedResult,
    type: row.type,
    priority: row.priority,
    // Versions recovered from old run snapshots may lack `data`.
    steps: steps.map((step, index) => ({
      position: step.position ?? index + 1,
      action: step.action,
      expectedResult: step.expectedResult ?? null,
      data: step.data ?? null,
    })),
    parameters: parametersOf(row),
    dataset: datasetOf(row),
  };
}
