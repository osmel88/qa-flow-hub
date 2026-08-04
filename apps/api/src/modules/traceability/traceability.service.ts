import { Injectable } from '@nestjs/common';
import { AuditAction, TraceabilityLink } from '@prisma/client';
import {
  CreateTraceLinkInput,
  ListTraceLinksQuery,
  MatrixCase,
  MatrixRow,
  TraceLinkView,
  TraceabilityMatrix,
  TraceabilityMatrixQuery,
} from '@qa-flow-hub/shared';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { DefectsRepository, OUTSTANDING_STATUSES } from '../defects/defects.repository';
import { ProjectsRepository } from '../projects/projects.repository';
import { TraceabilityRepository } from './traceability.repository';

@Injectable()
export class TraceabilityService {
  constructor(
    private readonly links: DefectsRepository,
    private readonly reads: TraceabilityRepository,
    private readonly projects: ProjectsRepository,
    private readonly audit: AuditService,
  ) {}

  async createLink(input: CreateTraceLinkInput, userId: string): Promise<TraceLinkView> {
    // Both ends are checked against the tenant, so a link cannot be used to
    // confirm that an id exists in another organization.
    for (const [type, id] of [
      [input.sourceType, input.sourceId],
      [input.targetType, input.targetId],
    ] as const) {
      if (!(await this.reads.entityExists(type, id))) {
        throw new ValidationError(`No ${type} with id ${id} in this organization`);
      }
    }

    const existing = await this.links.findLink({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      targetType: input.targetType,
      targetId: input.targetId,
      linkType: input.linkType,
    });
    if (existing !== null) {
      throw new ConflictError('That link already exists');
    }

    const link = await this.links.createLink({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      targetType: input.targetType,
      targetId: input.targetId,
      linkType: input.linkType,
      createdById: userId,
    });

    await this.audit.record({
      action: AuditAction.create,
      entityType: 'TraceabilityLink',
      entityId: link.id,
      summary: `Linked ${input.sourceType} to ${input.targetType} as ${input.linkType}`,
    });

    return toLinkView(link);
  }

  async listLinks(query: ListTraceLinksQuery): Promise<TraceLinkView[]> {
    return (await this.links.linksFor(query.entityType, query.entityId)).map(toLinkView);
  }

  async removeLink(id: string): Promise<void> {
    if (!(await this.links.deleteLink(id))) {
      throw new NotFoundError('Traceability link');
    }

    await this.audit.record({
      action: AuditAction.delete,
      entityType: 'TraceabilityLink',
      entityId: id,
      summary: 'Removed a traceability link',
    });
  }

  /**
   * The matrix answers the question an auditor asks: which requirements are
   * covered by a test, which of those tests actually passed, and what is still
   * broken. Built with four queries, none of them per requirement.
   */
  async matrix(query: TraceabilityMatrixQuery): Promise<TraceabilityMatrix> {
    const project = await this.projects.findById(query.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }

    const requirements = await this.reads.listRequirements(project.id);
    const requirementIds = requirements.map((requirement) => requirement.id);

    const caseLinks = await this.links.linksBetweenTypes(
      'requirement',
      'test_case',
      requirementIds,
    );
    const defectLinks = await this.links.linksBetweenTypes('defect', 'requirement');

    const caseIds = [...new Set(caseLinks.map((link) => link.targetId))];
    const [cases, statuses, defects] = await Promise.all([
      this.reads.listCasesByIds(caseIds),
      this.reads.latestStatusByCase(caseIds),
      this.links.listForProject(project.id),
    ]);

    const caseById = new Map(cases.map((testCase) => [testCase.id, testCase]));
    const outstanding = new Set<string>(OUTSTANDING_STATUSES);

    const casesByRequirement = new Map<string, MatrixCase[]>();
    for (const link of caseLinks) {
      const testCase = caseById.get(link.targetId);
      if (testCase === undefined) {
        // The case was deleted; the link survives so history stays readable.
        continue;
      }
      const row = casesByRequirement.get(link.sourceId) ?? [];
      row.push({
        id: testCase.id,
        key: testCase.key,
        title: testCase.title,
        lastStatus: statuses.get(testCase.id) ?? 'untested',
      });
      casesByRequirement.set(link.sourceId, row);
    }

    const defectsByRequirement = new Map<string, string[]>();
    const openDefectIds = new Set(
      defects.filter((defect) => outstanding.has(defect.status)).map((defect) => defect.id),
    );
    for (const link of defectLinks) {
      if (!openDefectIds.has(link.sourceId)) {
        continue;
      }
      const row = defectsByRequirement.get(link.targetId) ?? [];
      row.push(link.sourceId);
      defectsByRequirement.set(link.targetId, row);
    }

    const rows: MatrixRow[] = requirements.map((requirement) => {
      const linked = casesByRequirement.get(requirement.id) ?? [];
      return {
        requirementId: requirement.id,
        key: requirement.key,
        title: requirement.title,
        status: requirement.status,
        priority: requirement.priority,
        cases: linked,
        defectIds: defectsByRequirement.get(requirement.id) ?? [],
        covered: linked.length > 0,
        // Covered means somebody wrote a test. Verified means it ran and
        // passed, and nothing linked to it is currently broken.
        verified:
          linked.length > 0 &&
          linked.every((testCase) => testCase.lastStatus === 'passed') &&
          (defectsByRequirement.get(requirement.id) ?? []).length === 0,
      };
    });

    const visible = query.uncoveredOnly === 'true' ? rows.filter((row) => !row.covered) : rows;
    const covered = rows.filter((row) => row.covered).length;
    const verified = rows.filter((row) => row.verified).length;

    return {
      projectId: project.id,
      rows: visible,
      summary: {
        requirements: rows.length,
        covered,
        verified,
        coverage:
          rows.length === 0 ? 0 : Math.round((covered / rows.length) * 1000) / 10,
        uncovered: rows.length - covered,
        openDefects: openDefectIds.size,
      },
    };
  }
}

function toLinkView(link: TraceabilityLink): TraceLinkView {
  return {
    id: link.id,
    sourceType: link.sourceType,
    sourceId: link.sourceId,
    targetType: link.targetType,
    targetId: link.targetId,
    linkType: link.linkType,
    createdById: link.createdById,
    createdAt: link.createdAt.toISOString(),
  };
}
