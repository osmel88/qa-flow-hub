import { Injectable } from '@nestjs/common';
import { ApiKey, ApiKeyScope as DbApiKeyScope, AuditAction, ProjectStatus } from '@prisma/client';
import type {
  ApiKeyScope,
  ApiKeyView,
  CreateApiKeyInput,
  CreatedApiKeyView,
} from '@qa-flow-hub/shared';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../database/prisma.service';
import { ConflictError, NotFoundError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { generateToken } from './api-key-token';
import { ApiKeysRepository } from './api-keys.repository';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lifecycle of project API keys, for humans holding `api_keys.manage`. The
 * token exists in clear only in the response to `create`; afterwards a key is
 * identified by its prefix.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly keys: ApiKeysRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  async list(projectId: string): Promise<ApiKeyView[]> {
    const project = await this.requireProject(projectId);
    const now = new Date();
    return (await this.keys.list(project.id)).map((key) => toApiKeyView(key, now));
  }

  async create(
    projectId: string,
    input: CreateApiKeyInput,
    userId: string,
  ): Promise<CreatedApiKeyView> {
    const project = await this.requireProject(projectId);
    if (project.status === ProjectStatus.archived || project.archivedAt !== null) {
      throw new ConflictError('The project is archived; restore it before creating API keys');
    }
    const now = new Date();
    const generated = generateToken();
    const scopes = [...new Set(input.scopes)].map(toDbScope);
    const expiresAt =
      input.expiresInDays === undefined || input.expiresInDays === null
        ? null
        : new Date(now.getTime() + input.expiresInDays * DAY_MS);

    const key = await this.prisma.runInTransaction(async (tx) => {
      await this.keys.lockProjectKeys(project.id, tx);
      const max = this.config.ingestion.maxActiveKeysPerProject;
      if ((await this.keys.countActive(project.id, now, tx)) >= max) {
        throw new ConflictError(
          `A project can have at most ${max} active API keys; revoke one first`,
        );
      }
      const created = await this.keys.create(
        {
          projectId: project.id,
          name: input.name,
          prefix: generated.prefix,
          secretHash: generated.secretHash,
          scopes,
          expiresAt,
          createdById: userId,
        },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.create,
          entityType: 'ApiKey',
          entityId: created.id,
          summary: `Created API key ${created.name} (qfh_${created.prefix}) for ${project.key}`,
          changes: {
            projectId: project.id,
            name: created.name,
            prefix: created.prefix,
            scopes: input.scopes,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        },
        tx,
      );
      return created;
    });

    return { key: toApiKeyView(key, now), token: generated.token };
  }

  async revoke(projectId: string, id: string, userId: string): Promise<ApiKeyView> {
    const project = await this.requireProject(projectId);
    let now = new Date();
    const key = await this.prisma.runInTransaction(async (tx) => {
      const existing = await this.keys.findInProject(project.id, id, tx);
      if (existing === null) {
        throw new NotFoundError('API key');
      }
      await this.keys.lockForRevoke(existing.id, tx);
      now = new Date();
      // Revoking twice is a no-op, not an error, and audits once.
      if (await this.keys.revoke(existing.id, userId, now, tx)) {
        await this.audit.record(
          {
            action: AuditAction.revoke,
            entityType: 'ApiKey',
            entityId: existing.id,
            summary: `Revoked API key ${existing.name} (qfh_${existing.prefix})`,
            changes: { projectId: project.id, prefix: existing.prefix },
          },
          tx,
        );
      }
      return this.keys.findInProject(project.id, id, tx);
    });
    if (key === null) {
      throw new NotFoundError('API key');
    }
    return toApiKeyView(key, now);
  }

  private async requireProject(projectId: string) {
    const project = await this.projects.findById(projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);
    return project;
  }
}

export function toDbScope(scope: ApiKeyScope): DbApiKeyScope {
  switch (scope) {
    case 'results:ingest':
      return DbApiKeyScope.results_ingest;
  }
}

export function fromDbScope(scope: DbApiKeyScope): ApiKeyScope {
  switch (scope) {
    case DbApiKeyScope.results_ingest:
      return 'results:ingest';
  }
}

export function toApiKeyView(key: ApiKey, now: Date): ApiKeyView {
  return {
    id: key.id,
    projectId: key.projectId,
    name: key.name,
    prefix: `qfh_${key.prefix}`,
    scopes: key.scopes.map(fromDbScope),
    state:
      key.revokedAt !== null
        ? 'revoked'
        : key.expiresAt !== null && key.expiresAt <= now
          ? 'expired'
          : 'active',
    expiresAt: key.expiresAt?.toISOString() ?? null,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    createdById: key.createdById,
    createdAt: key.createdAt.toISOString(),
  };
}
