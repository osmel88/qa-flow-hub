import { Injectable } from '@nestjs/common';
import { AuditAction, Environment, Prisma } from '@prisma/client';
import {
  CreateEnvironmentInput,
  DeploymentStatus,
  EnvironmentKind,
  EnvironmentMetadata,
  EnvironmentStatus,
  EnvironmentVersionInput,
  EnvironmentView,
  ListEnvironmentsQuery,
  UpdateEnvironmentInput,
  computeEnvironmentHealth,
  defaultProtected,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { ConflictError, DuplicateResourceError, NotFoundError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { DevelopmentRepository } from './development.repository';

const ENVIRONMENT = 'Environment';

/**
 * Environments (S6-F1). Each write locks the environment row `FOR UPDATE`;
 * deployments lock it `FOR SHARE`, so archiving waits for a deployment being
 * recorded and the other way round. An environment with deployment history
 * is never deleted, only archived; names stay unique per project among the
 * live (archived included) environments.
 */
@Injectable()
export class EnvironmentsService {
  constructor(
    private readonly repo: DevelopmentRepository,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListEnvironmentsQuery): Promise<EnvironmentView[]> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return [];
    }
    const statuses: readonly EnvironmentStatus[] | undefined =
      query.status !== undefined
        ? [query.status]
        : query.includeArchived === 'true'
          ? undefined
          : ['active', 'inactive'];
    const rows = await this.repo.environments(projectId, {
      statuses,
      kind: query.kind,
      protected: query.protected === undefined ? undefined : query.protected === 'true',
      search: query.search,
    });
    const views = await this.views(projectId, rows);
    return query.health === undefined
      ? views
      : views.filter((view) => view.health === query.health);
  }

  async get(id: string): Promise<EnvironmentView> {
    const row = await this.requireVisible(id);
    return (await this.views(row.projectId, [row]))[0]!;
  }

  async create(input: CreateEnvironmentInput, userId: string): Promise<EnvironmentView> {
    const projectId = await this.access.authorizeProjectScope(input.projectId);
    if (projectId === null) {
      throw new NotFoundError('Project');
    }
    const row = await this.unique(() =>
      this.prisma.runInTransaction(async (tx) => {
        const created = await this.repo.createEnvironment(
          {
            projectId,
            name: input.name,
            kind: input.kind,
            description: input.description ?? null,
            protected: defaultProtected(input.kind, input.protected),
            position: input.position ?? 0,
            url: input.url ?? null,
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            createdById: userId,
          },
          tx,
        );
        await this.record(
          tx,
          AuditAction.create,
          created.id,
          `Created environment ${created.name}`,
          {
            name: created.name,
            kind: created.kind,
            protected: created.protected,
          },
        );
        return created;
      }),
    );
    return (await this.views(projectId, [row]))[0]!;
  }

  async update(id: string, input: UpdateEnvironmentInput): Promise<EnvironmentView> {
    await this.requireVisible(id);
    const row = await this.unique(() =>
      this.prisma.runInTransaction(async (tx) => {
        const current = await this.lock(id, input.version, tx);
        if (current.status === 'archived') {
          throw new ConflictError(`Environment ${current.name} is archived; restore it first`);
        }
        const data: Prisma.EnvironmentUncheckedUpdateInput = {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.protected === undefined ? {} : { protected: input.protected }),
          ...(input.position === undefined ? {} : { position: input.position }),
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.metadata === undefined
            ? {}
            : { metadata: input.metadata === null ? Prisma.DbNull : input.metadata }),
          ...(input.status === undefined ? {} : { status: input.status }),
        };
        const updated = await this.repo.updateEnvironment(id, data, tx);
        const changes = Object.fromEntries(
          Object.keys(data).map((key) => [
            key,
            {
              from: current[key as keyof Environment] ?? null,
              to: updated[key as keyof Environment] ?? null,
            },
          ]),
        );
        await this.record(
          tx,
          AuditAction.update,
          id,
          `Updated environment ${updated.name}`,
          changes,
        );
        return updated;
      }),
    );
    return (await this.views(row.projectId, [row]))[0]!;
  }

  /** Archives, keeping history; refused while a deployment there is still in flight. */
  async archive(id: string, input: EnvironmentVersionInput): Promise<EnvironmentView> {
    await this.requireVisible(id);
    const row = await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lock(id, input.version, tx);
      if (current.status === 'archived') {
        throw new ConflictError(`Environment ${current.name} is already archived`);
      }
      const history = await this.repo.environmentHistory(id, tx);
      if (history.inFlight > 0) {
        throw new ConflictError(
          `Environment ${current.name} has ${history.inFlight} deployment(s) in flight; finish them first`,
        );
      }
      const updated = await this.repo.updateEnvironment(
        id,
        { status: 'archived', archivedAt: new Date() },
        tx,
      );
      await this.record(tx, AuditAction.update, id, `Archived environment ${current.name}`, {
        status: { from: current.status, to: 'archived' },
        deployments: history.total,
      });
      return updated;
    });
    return (await this.views(row.projectId, [row]))[0]!;
  }

  async restore(id: string, input: EnvironmentVersionInput): Promise<EnvironmentView> {
    await this.requireVisible(id);
    const row = await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lock(id, input.version, tx);
      if (current.status !== 'archived') {
        throw new ConflictError(`Environment ${current.name} is not archived`);
      }
      const updated = await this.repo.updateEnvironment(
        id,
        { status: 'active', archivedAt: null },
        tx,
      );
      await this.record(tx, AuditAction.update, id, `Restored environment ${current.name}`, {
        status: { from: 'archived', to: 'active' },
      });
      return updated;
    });
    return (await this.views(row.projectId, [row]))[0]!;
  }

  /** Only an environment that never had a deployment can go; the rest are archived. */
  async remove(id: string): Promise<void> {
    await this.requireVisible(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lock(id, undefined, tx);
      const history = await this.repo.environmentHistory(id, tx);
      if (history.total > 0) {
        throw new ConflictError(
          `Environment ${current.name} has deployment history; archive it instead`,
          { deployments: history.total },
        );
      }
      await tx.environment.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.record(tx, AuditAction.delete, id, `Deleted environment ${current.name}`, {
        name: current.name,
      });
    });
  }

  private async requireVisible(id: string): Promise<Environment> {
    const row = await this.repo.findEnvironment(id);
    if (row === null || (await this.access.authorizeProjectScope(row.projectId)) === null) {
      throw new NotFoundError(ENVIRONMENT);
    }
    return row;
  }

  private async lock(
    id: string,
    version: number | undefined,
    tx: PrismaTransaction,
  ): Promise<Environment> {
    const current = await this.repo.lockEnvironmentForUpdate(id, tx);
    if (current === null) {
      throw new NotFoundError(ENVIRONMENT);
    }
    if (version !== undefined && version !== current.version) {
      throw new ConflictError(
        'This environment was changed by someone else; reload and try again',
        {
          version: current.version,
        },
      );
    }
    return current;
  }

  private async unique<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateResourceError('environment', 'name');
      }
      throw error;
    }
  }

  private record(
    tx: PrismaTransaction,
    action: AuditAction,
    entityId: string,
    summary: string,
    changes: Record<string, unknown>,
  ) {
    return this.audit.record(
      {
        action,
        entityType: ENVIRONMENT,
        entityId,
        summary,
        changes: changes as Prisma.InputJsonValue,
      },
      tx,
    );
  }

  private async views(projectId: string, rows: Environment[]): Promise<EnvironmentView[]> {
    const stats = await this.repo.environmentStats(
      projectId,
      rows.map((row) => row.id),
    );
    const [builds, releases] = await Promise.all([
      this.repo.artifactsByIds(
        stats.current.flatMap((entry) => (entry.buildId === null ? [] : [entry.buildId])),
      ),
      this.repo.releases(
        stats.current.flatMap((entry) => (entry.releaseId === null ? [] : [entry.releaseId])),
      ),
    ]);
    return rows.map((row) => {
      const live = stats.current.find((entry) => entry.environmentId === row.id);
      const last = stats.last.find((entry) => entry.environmentId === row.id);
      const count = stats.counts.find((entry) => entry.environmentId === row.id);
      const status = row.status as EnvironmentStatus;
      return {
        id: row.id,
        projectId: row.projectId,
        name: row.name,
        description: row.description,
        kind: row.kind as EnvironmentKind,
        status,
        protected: row.protected,
        position: row.position,
        url: row.url,
        metadata: row.metadata as EnvironmentMetadata | null,
        version: row.version,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        archivedAt: row.archivedAt?.toISOString() ?? null,
        health: computeEnvironmentHealth(
          status,
          (last?.status ?? null) as DeploymentStatus | null,
          live !== undefined,
        ),
        deploymentCount: count?._count._all ?? 0,
        current:
          live === undefined
            ? null
            : {
                deploymentId: live.id,
                identifier: live.identifier,
                buildId: live.buildId,
                buildIdentifier:
                  builds.find((build) => build.id === live.buildId)?.identifier ?? null,
                commitSha: live.commitSha,
                release: releases.find((release) => release.id === live.releaseId) ?? null,
                deployedAt: live.finishedAt?.toISOString() ?? null,
              },
        lastDeployment:
          last === undefined
            ? null
            : {
                id: last.id,
                identifier: last.identifier,
                status: last.status as DeploymentStatus,
                at: last.createdAt.toISOString(),
              },
      };
    });
  }
}
