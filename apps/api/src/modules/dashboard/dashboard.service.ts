import { Injectable } from '@nestjs/common';
import { AuditLog } from '@prisma/client';
import {
  AuditEntryView,
  DashboardQuery,
  DashboardSummary,
  ListAuditQuery,
  Paginated,
} from '@qa-flow-hub/shared';
import { NotFoundError } from '../../errors';
import { ProjectsRepository } from '../projects/projects.repository';
import { DashboardRepository } from './dashboard.repository';

@Injectable()
export class DashboardService {
  constructor(
    private readonly dashboard: DashboardRepository,
    private readonly projects: ProjectsRepository,
  ) {}

  /**
   * Eight aggregate queries in parallel. None of them loads rows to count them,
   * and none of them runs per project or per requirement.
   */
  async summary(query: DashboardQuery): Promise<DashboardSummary> {
    if (query.projectId !== undefined && (await this.projects.findById(query.projectId)) === null) {
      throw new NotFoundError('Project');
    }
    const projectId = query.projectId;

    const [
      activeProjects,
      archivedProjects,
      requirements,
      testCases,
      runs,
      recentRuns,
      results,
      defects,
      requirementCount,
      coveredCount,
    ] = await Promise.all([
      this.dashboard.countProjects(false),
      this.dashboard.countProjects(true),
      this.dashboard.requirementsByStatus(projectId),
      this.dashboard.testCasesByStatus(projectId),
      this.dashboard.runsByStatus(projectId),
      this.dashboard.recentRuns(projectId),
      this.dashboard.resultsByStatus(projectId),
      this.dashboard.openDefectsBySeverity(projectId),
      this.dashboard.countRequirements(projectId),
      this.dashboard.countCoveredRequirements(projectId),
    ]);

    const runsByStatus = toRecord(runs);
    const completion = await this.dashboard.completionOfRuns(recentRuns.map((run) => run.id));

    return {
      projects: { active: activeProjects, archived: archivedProjects },
      requirements: { total: sum(requirements), byStatus: toRecord(requirements) },
      testCases: { total: sum(testCases), byStatus: toRecord(testCases) },
      runs: {
        active: (runsByStatus['planned'] ?? 0) + (runsByStatus['in_progress'] ?? 0),
        completed: runsByStatus['completed'] ?? 0,
        recent: recentRuns.map((run) => ({
          id: run.id,
          name: run.name,
          status: run.status,
          completion: completion.get(run.id) ?? 0,
          startedAt: run.startedAt?.toISOString() ?? null,
        })),
      },
      results: toRecord(results),
      defects: { open: sum(defects), bySeverity: toRecord(defects) },
      coverage: {
        requirements: requirementCount,
        covered: coveredCount,
        percentage:
          requirementCount === 0
            ? 0
            : Math.round((coveredCount / requirementCount) * 1000) / 10,
      },
    };
  }

  async audit(query: ListAuditQuery): Promise<Paginated<AuditEntryView>> {
    const page = await this.dashboard.listAudit(query, {
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
      ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
      ...(query.userId === undefined ? {} : { userId: query.userId }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
    });

    return { data: page.data.map(toAuditView), meta: page.meta };
  }
}

function sum(rows: Array<{ count: number }>): number {
  return rows.reduce((total, row) => total + row.count, 0);
}

function toRecord(rows: Array<{ key: string; count: number }>): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.key, row.count]));
}

/**
 * The user agent is deliberately not exposed: it is kept for forensics but adds
 * nothing to an activity feed, and it is the field most likely to carry noise.
 */
function toAuditView(entry: AuditLog): AuditEntryView {
  return {
    id: entry.id,
    userId: entry.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    summary: entry.summary,
    changes: entry.changes,
    ipAddress: entry.ipAddress,
    requestId: entry.requestId,
    createdAt: entry.createdAt.toISOString(),
  };
}
