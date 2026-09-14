import { Injectable } from '@nestjs/common';
import { InternalEntityState, SyncableEntity } from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

/** The little a traceability row needs to know about the entity it describes. */
export interface EntitySnapshot {
  id: string;
  key: string;
  label: string;
  state: Exclude<InternalEntityState, 'missing'>;
  updatedAt: Date;
  parentId: string | null;
}

export type EntitySnapshots = Record<SyncableEntity, Map<string, EntitySnapshot>>;

/**
 * Reads every linkable entity of a project *including* the archived and the
 * soft-deleted ones — six queries, whatever the size of the project.
 *
 * The business repositories hide deleted rows, which is right for every other
 * screen and wrong for this one: a reference to a deleted requirement is
 * precisely the kind of thing external traceability exists to surface.
 */
@Injectable()
export class ExternalTraceabilityRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  async snapshotProject(projectId: string): Promise<EntitySnapshots> {
    const where = this.scope({ projectId });
    const [requirements, defects, suites, cases, runs, results] = await Promise.all([
      this.prisma.requirement.findMany({
        where,
        select: { id: true, key: true, title: true, updatedAt: true, deletedAt: true },
      }),
      this.prisma.defect.findMany({
        where,
        select: { id: true, key: true, title: true, updatedAt: true, deletedAt: true },
      }),
      this.prisma.testSuite.findMany({
        where,
        select: { id: true, name: true, updatedAt: true, deletedAt: true },
      }),
      this.prisma.testCase.findMany({
        where,
        select: {
          id: true,
          key: true,
          title: true,
          updatedAt: true,
          archivedAt: true,
          deletedAt: true,
          suiteId: true,
        },
      }),
      this.prisma.testRun.findMany({
        where,
        select: { id: true, name: true, status: true, updatedAt: true, deletedAt: true },
      }),
      this.prisma.testResult.findMany({
        where: this.scope({ testRun: { projectId } }),
        select: {
          id: true,
          status: true,
          executedAt: true,
          testRunId: true,
          testRun: { select: { name: true, deletedAt: true } },
          testRunCase: { select: { testCase: { select: { key: true } } } },
        },
      }),
    ]);

    const index = (entries: EntitySnapshot[]): Map<string, EntitySnapshot> =>
      new Map(entries.map((entry) => [entry.id, entry]));

    return {
      requirement: index(
        requirements.map((row) => ({
          id: row.id,
          key: row.key,
          label: row.title,
          state: row.deletedAt === null ? 'active' : 'deleted',
          updatedAt: row.updatedAt,
          parentId: null,
        })),
      ),
      defect: index(
        defects.map((row) => ({
          id: row.id,
          key: row.key,
          label: row.title,
          state: row.deletedAt === null ? 'active' : 'deleted',
          updatedAt: row.updatedAt,
          parentId: null,
        })),
      ),
      test_suite: index(
        suites.map((row) => ({
          id: row.id,
          key: row.name,
          label: row.name,
          state: row.deletedAt === null ? 'active' : 'deleted',
          updatedAt: row.updatedAt,
          parentId: null,
        })),
      ),
      test_case: index(
        cases.map((row) => ({
          id: row.id,
          key: row.key,
          label: row.title,
          state:
            row.deletedAt !== null ? 'deleted' : row.archivedAt !== null ? 'archived' : 'active',
          updatedAt: row.updatedAt,
          parentId: row.suiteId,
        })),
      ),
      test_run: index(
        runs.map((row) => ({
          id: row.id,
          key: row.name,
          label: `${row.name} (${row.status})`,
          state: row.deletedAt === null ? 'active' : 'deleted',
          updatedAt: row.updatedAt,
          parentId: null,
        })),
      ),
      test_result: index(
        results.map((row) => ({
          id: row.id,
          key: `${row.testRunCase.testCase.key} · ${row.status}`,
          label: `${row.testRun.name} › ${row.testRunCase.testCase.key} · ${row.status}`,
          state: row.testRun.deletedAt === null ? 'active' : 'deleted',
          updatedAt: row.executedAt,
          parentId: row.testRunId,
        })),
      ),
    };
  }
}
