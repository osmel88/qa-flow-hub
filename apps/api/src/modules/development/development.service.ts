import { Injectable } from '@nestjs/common';
import { AuditAction, DevelopmentArtifact, Prisma } from '@prisma/client';
import {
  CreateDevelopmentArtifactInput,
  DEVELOPMENT_ARTIFACT_KINDS,
  DevelopmentArtifactKind,
  DevelopmentArtifactView,
  DevelopmentLinkResult,
  DevelopmentWorkItemRef,
  ListDevelopmentArtifactsQuery,
  Paginated,
  UpdateDevelopmentArtifactInput,
  WorkItemDevelopmentView,
  artifactReference,
  naturalKeyOf,
  statusesFor,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import {
  ConflictError,
  DuplicateResourceError,
  NotFoundError,
  ValidationError,
} from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { DevelopmentRepository, LinkWithWorkItem } from './development.repository';

const ARTIFACT = 'Development artifact';

interface LinkEnds {
  artifactId: string;
  workItemId: string;
}

/**
 * Development links (S5-F1). Artifacts and work items must be live, in the
 * same project and visible to the caller; any other id answers like a
 * missing one. Linking and unlinking are idempotent. Lock order: artifact,
 * then work item(s), always.
 */
@Injectable()
export class DevelopmentService {
  constructor(
    private readonly repo: DevelopmentRepository,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    input: CreateDevelopmentArtifactInput,
    userId: string,
  ): Promise<DevelopmentArtifactView> {
    const projectId = await this.access.authorizeProjectScope(input.projectId);
    if (projectId === null) {
      throw new NotFoundError('Project');
    }
    const workItemIds = [...new Set(input.workItemIds)].sort();
    let created: DevelopmentArtifact;
    try {
      created = await this.prisma.runInTransaction(async (tx) => {
        const items = await this.repo.lockWorkItems(projectId, workItemIds, tx);
        if (items.length !== workItemIds.length) {
          throw new NotFoundError('Work item');
        }
        const row = await this.repo.create(
          {
            projectId,
            kind: input.kind,
            provider: input.provider,
            externalId: input.externalId ?? null,
            naturalKey: naturalKeyOf(input),
            url: input.url ?? null,
            title: input.title ?? null,
            branchName: input.kind === 'branch' ? (input.branchName ?? null) : null,
            commitSha: input.kind === 'commit' ? (input.commitSha ?? null) : null,
            prNumber: input.kind === 'pull_request' ? (input.prNumber ?? null) : null,
            identifier:
              input.kind === 'build' || input.kind === 'deployment'
                ? (input.identifier ?? null)
                : null,
            environment: input.environment ?? null,
            status: input.status ?? null,
            occurredAt: input.occurredAt === undefined ? null : new Date(input.occurredAt),
            createdById: userId,
          },
          tx,
        );
        await this.audit.record(
          {
            action: AuditAction.create,
            entityType: 'DevelopmentArtifact',
            entityId: row.id,
            summary: `Recorded ${row.kind} ${artifactReference(row)} (${row.provider})`,
            changes: { kind: row.kind, provider: row.provider, reference: row.naturalKey },
          },
          tx,
        );
        await this.repo.insertLinks(projectId, row.id, workItemIds, userId, tx);
        for (const item of items) {
          await this.auditLink(AuditAction.create, row, item, tx);
        }
        return row;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateResourceError(`${input.kind.replace('_', ' ')}`, 'reference');
      }
      throw error;
    }
    return this.view(created);
  }

  async list(query: ListDevelopmentArtifactsQuery): Promise<Paginated<DevelopmentArtifactView>> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return {
        data: [],
        meta: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 0 },
      };
    }
    const page = await this.repo.list(query, {
      projectId,
      kind: query.kind,
      provider: query.provider,
      status: query.status,
      workItemId: query.workItemId === 'none' ? null : query.workItemId,
      search: query.search,
    });
    const links = grouped(await this.repo.linksOfArtifacts(page.data.map((row) => row.id)));
    return {
      data: page.data.map((row) => toArtifactView(row, links.get(row.id) ?? [])),
      meta: page.meta,
    };
  }

  async get(id: string): Promise<DevelopmentArtifactView> {
    return this.view(await this.requireVisible(id));
  }

  async update(
    id: string,
    input: UpdateDevelopmentArtifactInput,
  ): Promise<DevelopmentArtifactView> {
    await this.requireVisible(id);
    const updated = await this.prisma.runInTransaction(async (tx) => {
      const current = await this.repo.lockArtifact(id, 'update', tx);
      if (current === null) {
        throw new NotFoundError(ARTIFACT);
      }
      if (input.version !== undefined && input.version !== current.version) {
        throw new ConflictError('This artifact was changed by someone else; reload and try again', {
          version: current.version,
        });
      }
      if (
        input.status !== undefined &&
        input.status !== null &&
        !statusesFor(current.kind).includes(input.status)
      ) {
        throw new ValidationError(`A ${current.kind} has no status ${input.status}`);
      }
      if (
        input.environment !== undefined &&
        input.environment !== null &&
        current.kind !== 'deployment'
      ) {
        throw new ValidationError('Only deployments have an environment');
      }
      const data: Prisma.DevelopmentArtifactUncheckedUpdateManyInput = {};
      const changes: Record<string, Prisma.InputJsonValue | null> = {};
      const assign = <K extends 'title' | 'url' | 'environment' | 'status'>(key: K): void => {
        const value = input[key];
        if (value !== undefined && value !== current[key]) {
          data[key] = value;
          changes[key] = { from: current[key], to: value };
        }
      };
      assign('title');
      assign('url');
      assign('environment');
      assign('status');
      if (input.occurredAt !== undefined) {
        const next = input.occurredAt === null ? null : new Date(input.occurredAt);
        if ((next?.getTime() ?? null) !== (current.occurredAt?.getTime() ?? null)) {
          data.occurredAt = next;
          changes['occurredAt'] = {
            from: current.occurredAt?.toISOString() ?? null,
            to: next?.toISOString() ?? null,
          };
        }
      }
      if (Object.keys(data).length > 0) {
        await this.repo.update(id, data, tx);
        await this.audit.record(
          {
            action: AuditAction.update,
            entityType: 'DevelopmentArtifact',
            entityId: id,
            summary: `Updated ${current.kind} ${artifactReference(current)}`,
            changes,
          },
          tx,
        );
      }
      const row = await this.repo.findArtifact(id, tx);
      if (row === null) {
        throw new NotFoundError(ARTIFACT);
      }
      return row;
    });
    return this.view(updated);
  }

  /** Soft delete: the artifact and its links disappear from every view. */
  async remove(id: string): Promise<void> {
    await this.requireVisible(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.repo.lockArtifact(id, 'update', tx);
      if (current === null || !(await this.repo.softDelete(id, tx))) {
        throw new NotFoundError(ARTIFACT);
      }
      await this.audit.record(
        {
          action: AuditAction.delete,
          entityType: 'DevelopmentArtifact',
          entityId: id,
          summary: `Deleted ${current.kind} ${artifactReference(current)}`,
        },
        tx,
      );
    });
  }

  async link(ends: LinkEnds, userId: string): Promise<DevelopmentLinkResult> {
    return this.prisma.runInTransaction(async (tx) => {
      const { artifact, workItem } = await this.lockEnds(ends, tx);
      const created =
        (await this.repo.insertLinks(
          artifact.projectId,
          artifact.id,
          [workItem.id],
          userId,
          tx,
        )) === 1;
      if (created) {
        await this.auditLink(AuditAction.create, artifact, workItem, tx);
      }
      return { created, workItemId: workItem.id, artifactId: artifact.id };
    });
  }

  /** Removing a link that is not there succeeds and records nothing. */
  async unlink(ends: LinkEnds): Promise<void> {
    await this.prisma.runInTransaction(async (tx) => {
      const { artifact, workItem } = await this.lockEnds(ends, tx);
      if ((await this.repo.removeLink(workItem.id, artifact.id, tx)) !== null) {
        await this.auditLink(AuditAction.delete, artifact, workItem, tx);
      }
    });
  }

  async forWorkItem(workItemId: string): Promise<WorkItemDevelopmentView> {
    const workItem = await this.repo.findWorkItem(workItemId);
    if (workItem === null) {
      throw new NotFoundError('Work item');
    }
    await this.access.assertRouteAccess(workItem.projectId, 'Work item');
    const rows = await this.repo.linksOfWorkItem(workItem.id);
    const links = grouped(await this.repo.linksOfArtifacts(rows.map((row) => row.artifactId)));
    const counts = Object.fromEntries(
      DEVELOPMENT_ARTIFACT_KINDS.map((kind) => [kind, 0]),
    ) as Record<DevelopmentArtifactKind, number>;
    for (const row of rows) {
      counts[row.artifact.kind] += 1;
    }
    return {
      workItemId: workItem.id,
      artifacts: rows.map((row) => ({
        ...toArtifactView(row.artifact, links.get(row.artifactId) ?? []),
        linkId: row.id,
        linkedAt: row.createdAt.toISOString(),
      })),
      counts,
    };
  }

  private async lockEnds(ends: LinkEnds, tx: PrismaTransaction) {
    const artifact = await this.repo.lockArtifact(ends.artifactId, 'share', tx);
    if (artifact === null) {
      throw new NotFoundError(ARTIFACT);
    }
    await this.access.assertRouteAccess(artifact.projectId, ARTIFACT);
    const workItem = await this.repo.lockWorkItem(ends.workItemId, tx);
    if (workItem === null || workItem.projectId !== artifact.projectId) {
      throw new NotFoundError('Work item');
    }
    return { artifact, workItem };
  }

  private async auditLink(
    action: AuditAction,
    artifact: DevelopmentArtifact,
    workItem: { id: string; key: string },
    tx: PrismaTransaction,
  ): Promise<void> {
    const reference = `${artifact.kind} ${artifactReference(artifact)}`;
    await this.audit.record(
      {
        action,
        entityType: 'WorkItemDevelopmentLink',
        entityId: `${workItem.id}:${artifact.id}`,
        summary:
          action === AuditAction.create
            ? `Linked ${workItem.key} to ${reference}`
            : `Unlinked ${workItem.key} from ${reference}`,
        changes: { workItemId: workItem.id, artifactId: artifact.id },
      },
      tx,
    );
  }

  private async requireVisible(id: string): Promise<DevelopmentArtifact> {
    const row = await this.repo.findArtifact(id);
    if (row === null) {
      throw new NotFoundError(ARTIFACT);
    }
    await this.access.assertRouteAccess(row.projectId, ARTIFACT);
    return row;
  }

  private async view(row: DevelopmentArtifact): Promise<DevelopmentArtifactView> {
    return toArtifactView(row, await this.repo.linksOfArtifacts([row.id]));
  }
}

function grouped(links: readonly LinkWithWorkItem[]): Map<string, LinkWithWorkItem[]> {
  const result = new Map<string, LinkWithWorkItem[]>();
  for (const link of links) {
    const list = result.get(link.artifactId) ?? [];
    list.push(link);
    result.set(link.artifactId, list);
  }
  return result;
}

export function toArtifactView(
  row: DevelopmentArtifact,
  links: readonly LinkWithWorkItem[],
): DevelopmentArtifactView {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    provider: row.provider,
    externalId: row.externalId,
    url: row.url,
    title: row.title,
    branchName: row.branchName,
    commitSha: row.commitSha,
    prNumber: row.prNumber,
    identifier: row.identifier,
    environment: row.environment,
    status: row.status,
    occurredAt: row.occurredAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    workItems: links.map((link): DevelopmentWorkItemRef => ({
      linkId: link.id,
      workItemId: link.workItem.id,
      key: link.workItem.key,
      title: link.workItem.title,
      type: link.workItem.type,
      status: link.workItem.status,
      linkedAt: link.createdAt.toISOString(),
    })),
  };
}
