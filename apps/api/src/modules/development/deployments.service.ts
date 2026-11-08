import { Injectable } from '@nestjs/common';
import { AuditAction, DevelopmentArtifact, Prisma } from '@prisma/client';
import {
  BuildMetadata,
  CreateDeploymentInput,
  CreateDeploymentResult,
  DeploymentMetricsQuery,
  DeploymentMetricsView,
  DeploymentTrigger,
  DeploymentView,
  EnvironmentKind,
  EnvironmentStatus,
  PROTECTED_ENVIRONMENT_PERMISSION,
  ListDeploymentsQuery,
  Paginated,
  RollbackDeploymentInput,
  TransitionDeploymentInput,
  UpdateDeploymentInput,
  buildDurationMs,
  buildMetadataSchema,
  canTransitionDeployment,
  computeDeploymentMetrics,
  isFinishedDeploymentStatus,
  redactBuildMetadata,
  redactSecrets,
} from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import {
  ConflictError,
  DuplicateResourceError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
} from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { QualityGatesService } from '../releases/quality-gates.service';
import { ReleaseApprovalsService } from '../releases/release-approvals.service';
import { DevelopmentRepository, LinkWithWorkItem } from './development.repository';
import { DevelopmentService, toArtifactView } from './development.service';

const DEPLOYMENT = 'Deployment';

/**
 * Deployments (S5-F5): the `deployment` development artifact as a build
 * shipped to an environment. Reports are idempotent per (provider,
 * externalId). A rollback locks the original, requires it `succeeded`,
 * marks it `rolled_back` and records a new succeeded deployment pointing to
 * it; a partial unique index allows one live rollback per original. Lock
 * order: artifact(s), environment, build, release, work items. Since S6-F1 a
 * protected environment needs `work_items.manage` to deploy to, move a
 * deployment in, or roll back, and only active environments take new
 * deployments or rollbacks.
 */
@Injectable()
export class DeploymentsService {
  constructor(
    private readonly repo: DevelopmentRepository,
    private readonly development: DevelopmentService,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly qualityGates: QualityGatesService,
    private readonly releaseApprovals: ReleaseApprovalsService,
  ) {}

  // --- deployments -----------------------------------------------------------

  async create(input: CreateDeploymentInput, userId: string): Promise<CreateDeploymentResult> {
    const projectId = await this.requireProject(input.projectId);
    const existing = await this.byExternalId(projectId, input);
    if (existing !== null) {
      return { created: false, deployment: existing };
    }
    const workItemIds = [...new Set(input.workItemIds)].sort();
    const now = new Date();
    const startedAt =
      input.startedAt !== undefined
        ? new Date(input.startedAt)
        : input.status === 'pending'
          ? null
          : now;
    const finishedAt = isFinishedDeploymentStatus(input.status)
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
        const environment = await this.repo.lockEnvironment(projectId, input.environmentId, tx);
        if (environment === null) {
          throw new NotFoundError('Environment');
        }
        await this.assertDeployable(projectId, environment, true);
        if (environment.protected && input.status !== 'cancelled') {
          await this.qualityGates.assertDeployable(
            projectId,
            input.releaseId ?? null,
            environment,
            tx,
          );
          await this.releaseApprovals.assertApproved(
            projectId,
            input.releaseId ?? null,
            environment,
            tx,
          );
        }
        const build =
          input.buildId === undefined
            ? null
            : await this.repo.lockBuild(projectId, input.buildId, tx);
        if (input.buildId !== undefined && build === null) {
          throw new NotFoundError('Build');
        }
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
            kind: 'deployment',
            provider: input.provider,
            externalId: input.externalId ?? null,
            naturalKey: input.identifier,
            identifier: input.identifier,
            title: input.title ?? null,
            url: input.url ?? null,
            commitSha: input.commitSha ?? build?.commitSha ?? null,
            status: input.status,
            trigger: input.trigger,
            startedAt,
            finishedAt,
            occurredAt: finishedAt ?? startedAt ?? now,
            environment: environment.name,
            environmentId: environment.id,
            buildId: build?.id ?? null,
            releaseId: input.releaseId ?? null,
            actorId: userId,
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
            summary: `Recorded deployment ${input.identifier} to ${environment.name} (${input.status})`,
            changes: {
              kind: 'deployment',
              status: input.status,
              environmentId: environment.id,
              buildId: created.buildId,
              releaseId: created.releaseId,
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
        const winner = await this.byExternalId(projectId, input);
        if (winner !== null) {
          return { created: false, deployment: winner };
        }
        throw new DuplicateResourceError('deployment', 'reference');
      }
      throw error;
    }
    return { created: true, deployment: await this.get(row.id) };
  }

  async list(query: ListDeploymentsQuery): Promise<Paginated<DeploymentView>> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return {
        data: [],
        meta: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 0 },
      };
    }
    const page = await this.repo.list(query, {
      projectId,
      kind: 'deployment',
      status: query.status,
      provider: query.provider,
      environmentId: query.environmentId,
      releaseId: query.releaseId,
      buildId: query.buildId,
      workItemId: query.workItemId,
      search: query.search,
    });
    return { data: await this.views(page.data), meta: page.meta };
  }

  async get(id: string): Promise<DeploymentView> {
    const [view] = await this.views([await this.requireVisible(id)]);
    return view!;
  }

  async metrics(query: DeploymentMetricsQuery): Promise<DeploymentMetricsView> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    const since = new Date(Date.now() - query.days * 86_400_000);
    const rows =
      projectId === null
        ? []
        : await this.repo.deploymentRows(projectId, {
            environmentId: query.environmentId,
            releaseId: query.releaseId,
            since,
          });
    return {
      projectId: projectId ?? query.projectId,
      windowDays: query.days,
      ...computeDeploymentMetrics(rows),
    };
  }

  async transition(id: string, input: TransitionDeploymentInput): Promise<DeploymentView> {
    await this.requireVisible(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lockDeployment(id, input.version, tx);
      await this.assertEnvironmentAccess(current, tx);
      if (input.status === 'deploying' && current.environmentId !== null) {
        const environment = await this.repo.lockEnvironment(
          current.projectId,
          current.environmentId,
          tx,
        );
        if (environment?.protected === true) {
          await this.qualityGates.assertDeployable(
            current.projectId,
            current.releaseId,
            environment,
            tx,
          );
          await this.releaseApprovals.assertApproved(
            current.projectId,
            current.releaseId,
            environment,
            tx,
          );
        }
      }
      if (!canTransitionDeployment(current.status, input.status)) {
        throw new InvalidStateTransitionError(
          DEPLOYMENT,
          current.status ?? 'pending',
          input.status,
        );
      }
      const at = input.at === undefined ? new Date() : new Date(input.at);
      const startedAt = current.startedAt ?? at;
      if (at < startedAt) {
        throw new ValidationError('The deployment cannot finish before it started');
      }
      const finished = isFinishedDeploymentStatus(input.status);
      const data: Prisma.DevelopmentArtifactUncheckedUpdateManyInput = {
        status: input.status,
        startedAt,
        ...(finished ? { finishedAt: at, occurredAt: at } : {}),
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
          summary: `Deployment ${current.identifier ?? ''}: ${current.status ?? 'pending'} → ${input.status}`,
          changes: { status: { from: current.status, to: input.status } },
        },
        tx,
      );
      await this.development.auditStatusChanges(items, before, tx);
    });
    return this.get(id);
  }

  async update(id: string, input: UpdateDeploymentInput): Promise<DeploymentView> {
    await this.requireVisible(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lockDeployment(id, input.version, tx);
      await this.assertEnvironmentAccess(current, tx);
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
          summary: `Updated deployment ${current.identifier ?? ''}`,
          changes: { fields: Object.keys(data) },
        },
        tx,
      );
    });
    return this.get(id);
  }

  /**
   * Rolls a succeeded deployment back (local/mock: the rollback deployment
   * succeeds at once). Repeating, or racing, answers 409 for all but one.
   */
  async rollback(
    id: string,
    input: RollbackDeploymentInput,
    userId: string,
  ): Promise<DeploymentView> {
    const original = await this.requireVisible(id);
    let rollbackId: string;
    try {
      rollbackId = await this.prisma.runInTransaction(async (tx) => {
        const current = await this.lockDeployment(id, input.version, tx);
        if (current.status === 'rolled_back') {
          throw new ConflictError(`Deployment ${current.identifier ?? ''} was already rolled back`);
        }
        if (current.status !== 'succeeded') {
          throw new InvalidStateTransitionError(
            DEPLOYMENT,
            current.status ?? 'pending',
            'rolled_back',
          );
        }
        if (current.environmentId === null) {
          throw new ValidationError('Only a deployment to an environment can be rolled back');
        }
        const environment = await this.repo.lockEnvironment(
          current.projectId,
          current.environmentId,
          tx,
        );
        if (environment === null) {
          throw new NotFoundError('Environment');
        }
        await this.assertDeployable(current.projectId, environment, true);
        let targetBuildId: string | null = null;
        if (input.toBuildId !== undefined) {
          const build = await this.repo.lockBuild(current.projectId, input.toBuildId, tx);
          if (build === null) {
            throw new NotFoundError('Build');
          }
          targetBuildId = build.id;
        } else {
          targetBuildId =
            (
              await this.repo.previousDeployment(
                current.projectId,
                environment.id,
                current.createdAt,
                current.id,
              )
            )?.buildId ?? null;
        }
        const items = await this.repo.lockLinkedWorkItems(id, tx);
        const before = await this.development.captureStatuses(items, tx);
        const now = new Date();
        await this.repo.update(id, { status: 'rolled_back' }, tx);
        const created = await this.repo.create(
          {
            projectId: current.projectId,
            kind: 'deployment',
            provider: current.provider,
            naturalKey: `${current.identifier ?? current.id}-rollback`,
            identifier: `${current.identifier ?? current.id}-rollback`,
            title: input.reason ?? `Rollback of ${current.identifier ?? current.id}`,
            status: 'succeeded',
            trigger: 'rollback',
            startedAt: now,
            finishedAt: now,
            occurredAt: now,
            environment: environment.name,
            environmentId: environment.id,
            buildId: targetBuildId,
            releaseId: current.releaseId,
            rollbackOfId: current.id,
            actorId: userId,
            createdById: userId,
          },
          tx,
        );
        await this.audit.record(
          {
            action: AuditAction.update,
            entityType: 'DevelopmentArtifact',
            entityId: id,
            summary: `Rolled back deployment ${current.identifier ?? ''} on ${environment.name}`,
            changes: {
              status: { from: 'succeeded', to: 'rolled_back' },
              rollbackId: created.id,
              toBuildId: targetBuildId,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            },
          },
          tx,
        );
        await this.development.auditStatusChanges(items, before, tx);
        return created.id;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(`Deployment ${original.identifier ?? ''} was already rolled back`);
      }
      throw error;
    }
    return this.get(rollbackId);
  }

  // --- internals -------------------------------------------------------------

  /** Protected environments need the higher permission; new work needs an active one. */
  private async assertDeployable(
    projectId: string,
    environment: { name: string; status: string; protected: boolean },
    requireActive: boolean,
  ): Promise<void> {
    if (
      environment.protected &&
      !(await this.access.hasPermission(projectId, PROTECTED_ENVIRONMENT_PERMISSION))
    ) {
      throw new ForbiddenError(
        `Environment ${environment.name} is protected: deploying there needs ${PROTECTED_ENVIRONMENT_PERMISSION}`,
      );
    }
    if (requireActive && environment.status !== 'active') {
      throw new ConflictError(
        `Environment ${environment.name} is ${environment.status as EnvironmentStatus}; only active environments take deployments`,
      );
    }
  }

  private async assertEnvironmentAccess(
    deployment: DevelopmentArtifact,
    tx: Parameters<Parameters<PrismaService['runInTransaction']>[0]>[0],
  ): Promise<void> {
    if (deployment.environmentId === null) {
      return;
    }
    const environment = await this.repo.lockEnvironment(
      deployment.projectId,
      deployment.environmentId,
      tx,
    );
    if (environment !== null) {
      await this.assertDeployable(deployment.projectId, environment, false);
    }
  }

  private async requireProject(projectId: string): Promise<string> {
    const authorized = await this.access.authorizeProjectScope(projectId);
    if (authorized === null) {
      throw new NotFoundError('Project');
    }
    return authorized;
  }

  private async lockDeployment(
    id: string,
    version: number | undefined,
    tx: Parameters<Parameters<PrismaService['runInTransaction']>[0]>[0],
  ): Promise<DevelopmentArtifact> {
    const current = await this.repo.lockArtifact(id, 'update', tx);
    if (current === null || current.kind !== 'deployment') {
      throw new NotFoundError(DEPLOYMENT);
    }
    if (version !== undefined && version !== current.version) {
      throw new ConflictError('This deployment was changed by someone else; reload and try again', {
        version: current.version,
      });
    }
    return current;
  }

  private async byExternalId(
    projectId: string,
    input: CreateDeploymentInput,
  ): Promise<DeploymentView | null> {
    if (input.externalId === undefined) {
      return null;
    }
    const row = await this.repo.findDeploymentByExternalId(
      projectId,
      input.provider,
      input.externalId,
    );
    return row === null ? null : (await this.views([row]))[0]!;
  }

  private async requireVisible(id: string): Promise<DevelopmentArtifact> {
    const row = await this.repo.findArtifact(id);
    if (row === null || row.kind !== 'deployment') {
      throw new NotFoundError(DEPLOYMENT);
    }
    if ((await this.access.authorizeProjectScope(row.projectId)) === null) {
      throw new NotFoundError(DEPLOYMENT);
    }
    return row;
  }

  private async views(rows: DevelopmentArtifact[]): Promise<DeploymentView[]> {
    if (rows.length === 0) {
      return [];
    }
    const ids = (pick: (row: DevelopmentArtifact) => string | null) => [
      ...new Set(rows.flatMap((row) => (pick(row) === null ? [] : [pick(row)!]))),
    ];
    const [links, environments, artifacts, releases, rollbacks, users] = await Promise.all([
      this.repo.linksOfArtifacts(rows.map((row) => row.id)),
      this.repo.environmentsByIds(ids((row) => row.environmentId)),
      this.repo.artifactsByIds([...ids((row) => row.buildId), ...ids((row) => row.rollbackOfId)]),
      this.repo.releases(ids((row) => row.releaseId)),
      this.repo.rollbacksOf(rows.map((row) => row.id)),
      this.repo.users(ids((row) => row.actorId)),
    ]);
    const linksOf = new Map<string, LinkWithWorkItem[]>();
    for (const link of links) {
      linksOf.set(link.artifactId, [...(linksOf.get(link.artifactId) ?? []), link]);
    }
    const artifactOf = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    return rows.map((row) => {
      const environment = environments.find((entry) => entry.id === row.environmentId);
      const build = row.buildId === null ? undefined : artifactOf.get(row.buildId);
      const original = row.rollbackOfId === null ? undefined : artifactOf.get(row.rollbackOfId);
      const release = releases.find((entry) => entry.id === row.releaseId);
      const rollback = rollbacks.find((entry) => entry.rollbackOfId === row.id);
      const actor = users.find((user) => user.id === row.actorId);
      const parsed = row.metadata === null ? null : buildMetadataSchema.safeParse(row.metadata);
      return {
        ...toArtifactView(row, linksOf.get(row.id) ?? []),
        environmentRef:
          environment === undefined
            ? null
            : {
                id: environment.id,
                name: environment.name,
                kind: environment.kind as EnvironmentKind,
                status: environment.status as EnvironmentStatus,
                protected: environment.protected,
              },
        build:
          build === undefined
            ? null
            : { id: build.id, identifier: build.identifier, status: build.status },
        release: release ?? null,
        rollbackOf:
          original === undefined ? null : { id: original.id, identifier: original.identifier },
        rolledBackBy:
          rollback === undefined ? null : { id: rollback.id, identifier: rollback.identifier },
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        durationMs: buildDurationMs(row.startedAt, row.finishedAt),
        trigger: row.trigger as DeploymentTrigger | null,
        actor: actor ?? null,
        metadata: parsed?.success === true ? parsed.data : null,
        logSummary: row.logSummary,
      };
    });
  }
}

function metadataJson(
  metadata: BuildMetadata | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return metadata === undefined ? Prisma.DbNull : redactBuildMetadata(metadata);
}
