import { Injectable } from '@nestjs/common';
import { AuditAction, DevelopmentArtifact, Prisma } from '@prisma/client';
import {
  BuildMetadata,
  BuildMetricsQuery,
  BuildMetricsView,
  BuildTrigger,
  BuildView,
  CreateBuildInput,
  CreateBuildResult,
  ListBuildsQuery,
  Paginated,
  TransitionBuildInput,
  UpdateBuildInput,
  buildDurationMs,
  buildMetadataSchema,
  canTransitionBuild,
  computeBuildMetrics,
  isTerminalBuildStatus,
  redactBuildMetadata,
  redactSecrets,
} from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import {
  ConflictError,
  DuplicateResourceError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
} from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { DevelopmentRepository, LinkWithWorkItem } from './development.repository';
import { DevelopmentService, toArtifactView } from './development.service';

const BUILD = 'Build';

/**
 * Builds (S5-F4): the `build` development artifact as a CI run. Reporting a
 * build again with the same (provider, externalId) returns the existing one.
 * Lock order: artifact, release, work items. Logs and metadata are redacted
 * before they are stored.
 */
@Injectable()
export class BuildsService {
  constructor(
    private readonly repo: DevelopmentRepository,
    private readonly development: DevelopmentService,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateBuildInput, userId: string): Promise<CreateBuildResult> {
    const projectId = await this.access.authorizeProjectScope(input.projectId);
    if (projectId === null) {
      throw new NotFoundError('Project');
    }
    const existing = await this.byExternalId(projectId, input);
    if (existing !== null) {
      return { created: false, build: existing };
    }
    const workItemIds = [...new Set(input.workItemIds)].sort();
    const now = new Date();
    const startedAt =
      input.startedAt !== undefined
        ? new Date(input.startedAt)
        : input.status === 'queued'
          ? null
          : now;
    const finishedAt = isTerminalBuildStatus(input.status)
      ? input.finishedAt !== undefined
        ? new Date(input.finishedAt)
        : now
      : null;
    if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) {
      throw new ValidationError('finishedAt is before startedAt');
    }
    let row: DevelopmentArtifact;
    try {
      row = await this.prisma.runInTransaction(async (tx) => {
        if (
          input.releaseId !== undefined &&
          !(await this.repo.lockRelease(projectId, input.releaseId, tx))
        ) {
          throw new NotFoundError('Release');
        }
        const items = await this.repo.lockWorkItems(projectId, workItemIds, tx);
        if (items.length !== workItemIds.length) {
          throw new NotFoundError('Work item');
        }
        const before = await this.development.captureStatuses(items, tx);
        const created = await this.repo.create(
          {
            projectId,
            kind: 'build',
            provider: input.provider,
            externalId: input.externalId ?? null,
            naturalKey: input.identifier,
            identifier: input.identifier,
            title: input.title ?? null,
            url: input.url ?? null,
            branchName: input.branchName ?? null,
            commitSha: input.commitSha ?? null,
            status: input.status,
            trigger: input.trigger,
            startedAt,
            finishedAt,
            occurredAt: startedAt ?? now,
            releaseId: input.releaseId ?? null,
            metadata: metadataJson(input.metadata),
            logSummary: input.logSummary === undefined ? null : redactSecrets(input.logSummary),
            createdById: userId,
          },
          tx,
        );
        await this.audit.record(
          {
            action: AuditAction.create,
            entityType: 'DevelopmentArtifact',
            entityId: created.id,
            summary: `Recorded build ${input.identifier} (${input.provider}, ${input.status})`,
            changes: {
              kind: 'build',
              status: input.status,
              releaseId: created.releaseId,
              externalId: created.externalId,
            },
          },
          tx,
        );
        await this.repo.insertLinks(projectId, created.id, workItemIds, userId, tx);
        await this.development.auditStatusChanges(items, before, tx);
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // A concurrent report of the same externalId won the race: idempotent.
        const winner = await this.byExternalId(projectId, input);
        if (winner !== null) {
          return { created: false, build: winner };
        }
        throw new DuplicateResourceError('build', 'reference');
      }
      throw error;
    }
    return { created: true, build: await this.get(row.id) };
  }

  async list(query: ListBuildsQuery): Promise<Paginated<BuildView>> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return {
        data: [],
        meta: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 0 },
      };
    }
    const page = await this.repo.list(query, {
      projectId,
      kind: 'build',
      status: query.status,
      provider: query.provider,
      branchName: query.branch,
      releaseId: query.releaseId === 'none' ? null : query.releaseId,
      workItemId: query.workItemId,
      search: query.search,
    });
    return { data: await this.views(page.data), meta: page.meta };
  }

  async get(id: string): Promise<BuildView> {
    const [view] = await this.views([await this.requireVisible(id)]);
    return view!;
  }

  async metrics(query: BuildMetricsQuery): Promise<BuildMetricsView> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    const since = new Date(Date.now() - query.days * 86_400_000);
    const rows =
      projectId === null
        ? []
        : await this.repo.buildRows(projectId, {
            branchName: query.branch,
            releaseId: query.releaseId,
            since,
          });
    return {
      projectId: projectId ?? query.projectId,
      windowDays: query.days,
      ...computeBuildMetrics(rows),
    };
  }

  async transition(id: string, input: TransitionBuildInput): Promise<BuildView> {
    await this.requireVisible(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.repo.lockArtifact(id, 'update', tx);
      if (current === null || current.kind !== 'build') {
        throw new NotFoundError(BUILD);
      }
      if (input.version !== undefined && input.version !== current.version) {
        throw new ConflictError('This build was changed by someone else; reload and try again', {
          version: current.version,
        });
      }
      if (!canTransitionBuild(current.status, input.status)) {
        throw new InvalidStateTransitionError(BUILD, current.status ?? 'queued', input.status);
      }
      const at = input.at === undefined ? new Date() : new Date(input.at);
      const startedAt = current.startedAt ?? at;
      if (at < startedAt) {
        throw new ValidationError('The build cannot finish before it started');
      }
      const data: Prisma.DevelopmentArtifactUncheckedUpdateManyInput = {
        status: input.status,
        startedAt:
          input.status === 'running' || isTerminalBuildStatus(input.status)
            ? startedAt
            : current.startedAt,
        ...(isTerminalBuildStatus(input.status) ? { finishedAt: at } : {}),
        ...(current.occurredAt === null ? { occurredAt: startedAt } : {}),
        ...(input.logSummary === undefined ? {} : { logSummary: redactSecrets(input.logSummary) }),
      };
      const items = await this.repo.lockLinkedWorkItems(id, tx);
      const before = await this.development.captureStatuses(items, tx);
      await this.repo.update(id, data, tx);
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'DevelopmentArtifact',
          entityId: id,
          summary: `Build ${current.identifier ?? ''}: ${current.status ?? 'queued'} → ${input.status}`,
          changes: { status: { from: current.status, to: input.status } },
        },
        tx,
      );
      await this.development.auditStatusChanges(items, before, tx);
    });
    return this.get(id);
  }

  async update(id: string, input: UpdateBuildInput): Promise<BuildView> {
    await this.requireVisible(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.repo.lockArtifact(id, 'update', tx);
      if (current === null || current.kind !== 'build') {
        throw new NotFoundError(BUILD);
      }
      if (input.version !== undefined && input.version !== current.version) {
        throw new ConflictError('This build was changed by someone else; reload and try again', {
          version: current.version,
        });
      }
      if (
        input.releaseId !== undefined &&
        input.releaseId !== null &&
        !(await this.repo.lockRelease(current.projectId, input.releaseId, tx))
      ) {
        throw new NotFoundError('Release');
      }
      const data: Prisma.DevelopmentArtifactUncheckedUpdateManyInput = {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.branchName === undefined ? {} : { branchName: input.branchName }),
        ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }),
        ...(input.releaseId === undefined ? {} : { releaseId: input.releaseId }),
        ...(input.metadata === undefined
          ? {}
          : { metadata: input.metadata === null ? Prisma.DbNull : metadataJson(input.metadata) }),
        ...(input.logSummary === undefined
          ? {}
          : { logSummary: input.logSummary === null ? null : redactSecrets(input.logSummary) }),
      };
      await this.repo.update(id, data, tx);
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'DevelopmentArtifact',
          entityId: id,
          summary: `Updated build ${current.identifier ?? ''}`,
          changes: { fields: Object.keys(data) },
        },
        tx,
      );
    });
    return this.get(id);
  }

  private async byExternalId(
    projectId: string,
    input: CreateBuildInput,
  ): Promise<BuildView | null> {
    if (input.externalId === undefined) {
      return null;
    }
    const row = await this.repo.findBuildByExternalId(projectId, input.provider, input.externalId);
    return row === null ? null : (await this.views([row]))[0]!;
  }

  private async requireVisible(id: string): Promise<DevelopmentArtifact> {
    const row = await this.repo.findArtifact(id);
    if (row === null || row.kind !== 'build') {
      throw new NotFoundError(BUILD);
    }
    if ((await this.access.authorizeProjectScope(row.projectId)) === null) {
      throw new NotFoundError(BUILD);
    }
    return row;
  }

  private async views(rows: DevelopmentArtifact[]): Promise<BuildView[]> {
    if (rows.length === 0) {
      return [];
    }
    const projectId = rows[0]!.projectId;
    const [links, releases, related] = await Promise.all([
      this.repo.linksOfArtifacts(rows.map((row) => row.id)),
      this.repo.releases([
        ...new Set(rows.flatMap((row) => (row.releaseId === null ? [] : [row.releaseId]))),
      ]),
      this.repo.relatedArtifacts(
        projectId,
        rows.flatMap((row) => (row.branchName === null ? [] : [row.branchName])),
        rows.flatMap((row) => (row.commitSha === null ? [] : [row.commitSha])),
      ),
    ]);
    const linksOf = new Map<string, LinkWithWorkItem[]>();
    for (const link of links) {
      linksOf.set(link.artifactId, [...(linksOf.get(link.artifactId) ?? []), link]);
    }
    const releaseOf = new Map(releases.map((release) => [release.id, release]));
    const relatedId = (kind: 'branch' | 'commit', value: string | null, provider: string) =>
      value === null
        ? null
        : (related.find(
            (artifact) =>
              artifact.kind === kind &&
              (kind === 'branch' ? artifact.branchName : artifact.commitSha) === value &&
              artifact.provider === provider,
          )?.id ??
          related.find(
            (artifact) =>
              artifact.kind === kind &&
              (kind === 'branch' ? artifact.branchName : artifact.commitSha) === value,
          )?.id ??
          null);
    return rows.map((row) => {
      const parsed = row.metadata === null ? null : buildMetadataSchema.safeParse(row.metadata);
      return {
        ...toArtifactView(row, linksOf.get(row.id) ?? []),
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        durationMs: buildDurationMs(row.startedAt, row.finishedAt),
        trigger: row.trigger as BuildTrigger | null,
        release: row.releaseId === null ? null : (releaseOf.get(row.releaseId) ?? null),
        metadata: parsed?.success === true ? parsed.data : null,
        logSummary: row.logSummary,
        related: {
          branchId: relatedId('branch', row.branchName, row.provider),
          commitId: relatedId('commit', row.commitSha, row.provider),
        },
      };
    });
  }
}

function metadataJson(
  metadata: BuildMetadata | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return metadata === undefined ? Prisma.DbNull : redactBuildMetadata(metadata);
}
