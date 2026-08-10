import { Injectable } from '@nestjs/common';
import { AuditAction, Project, ProjectStatus } from '@prisma/client';
import {
  CreateProjectInput,
  ListProjectsQuery,
  Paginated,
  ProjectView,
  UpdateProjectInput,
} from '@qa-flow-hub/shared';
import { ConflictError, DuplicateResourceError, NotFoundError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from './project-access.service';
import { ProjectsRepository } from './projects.repository';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Note what is absent from every method here: `organizationId`. The
   * repository takes it from the request context, so this service cannot scope
   * a query to the wrong tenant even by mistake — there is no argument to get
   * wrong.
   */
  async create(input: CreateProjectInput): Promise<ProjectView> {
    if ((await this.projects.findByKey(input.key)) !== null) {
      // Checked here for a readable error; the database also has a unique
      // index on (organizationId, key), which is what actually guarantees it
      // under concurrency.
      throw new DuplicateResourceError('project', 'key');
    }

    const project = await this.projects.create({
      name: input.name,
      key: input.key,
      ...(input.description === undefined ? {} : { description: input.description }),
    });

    await this.audit.record({
      action: AuditAction.create,
      entityType: 'Project',
      entityId: project.id,
      summary: `Created the project ${project.key} — ${project.name}`,
      changes: { name: project.name, key: project.key },
    });

    return toProjectView(project);
  }

  list(query: ListProjectsQuery): Promise<Paginated<ProjectView>> {
    return this.projects
      .list(query, {
        ...(query.status === undefined ? {} : { status: query.status as ProjectStatus }),
        ...(query.search === undefined ? {} : { search: query.search }),
      })
      .then((page) => ({ data: page.data.map(toProjectView), meta: page.meta }));
  }

  async get(id: string): Promise<ProjectView> {
    return toProjectView(await this.require(id));
  }

  async update(id: string, input: UpdateProjectInput): Promise<ProjectView> {
    const existing = await this.require(id);

    // An archived project is read-only. Without this, "archived" would be a
    // label rather than a state, and a closed release could still be edited.
    if (existing.status === ProjectStatus.archived) {
      throw new ConflictError('Restore the project before editing it');
    }

    const updated = await this.projects.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    if (updated === null) {
      throw new NotFoundError('Project');
    }

    await this.audit.record({
      action: AuditAction.update,
      entityType: 'Project',
      entityId: id,
      summary: `Updated the project ${updated.key}`,
      changes: { ...input },
    });

    return toProjectView(updated);
  }

  /**
   * Archiving, not deleting. A project holds the test history somebody will be
   * asked about in an audit two years from now; the honest operation is "stop
   * using this", not "destroy it".
   */
  async archive(id: string): Promise<ProjectView> {
    const project = await this.require(id);
    if (project.status === ProjectStatus.archived) {
      throw new ConflictError('The project is already archived');
    }

    const updated = await this.projects.update(id, {
      status: ProjectStatus.archived,
      archivedAt: new Date(),
    });
    if (updated === null) {
      throw new NotFoundError('Project');
    }

    await this.audit.record({
      action: AuditAction.archive,
      entityType: 'Project',
      entityId: id,
      summary: `Archived the project ${project.key}`,
    });

    return toProjectView(updated);
  }

  async restore(id: string): Promise<ProjectView> {
    const project = await this.require(id);
    if (project.status !== ProjectStatus.archived) {
      throw new ConflictError('The project is not archived');
    }

    const updated = await this.projects.update(id, {
      status: ProjectStatus.active,
      archivedAt: null,
    });
    if (updated === null) {
      throw new NotFoundError('Project');
    }

    await this.audit.record({
      action: AuditAction.restore,
      entityType: 'Project',
      entityId: id,
      summary: `Restored the project ${project.key}`,
    });

    return toProjectView(updated);
  }

  private async require(id: string): Promise<Project> {
    const project = await this.projects.findById(id);
    if (project === null) {
      // The repository already filtered by organization, so another tenant's
      // project reaches this line as a plain 404. Not found and not yours are
      // the same answer on purpose.
      throw new NotFoundError('Project');
    }

    // The project is only known now, which is why this is not in a guard: the
    // route's roles are re-checked against the role this project grants.
    await this.access.assertRouteAccess(project.id);
    return project;
  }
}

export function toProjectView(project: Project): ProjectView {
  return {
    id: project.id,
    name: project.name,
    key: project.key,
    description: project.description,
    status: project.status,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}
