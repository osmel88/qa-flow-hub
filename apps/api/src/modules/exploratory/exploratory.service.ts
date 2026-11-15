import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import {
  AddSessionNoteInput,
  ConvertFindingInput,
  CreateExploratorySessionInput,
  CreateFindingInput,
  EXPLORATORY_ACTION_TARGET,
  ExploratoryAction,
  ExploratoryActionInput,
  ExploratorySessionDetailView,
  ExploratorySessionView,
  ExploratoryStatus,
  FindingKind,
  LinkSessionDefectInput,
  ListExploratorySessionsQuery,
  Paginated,
  UpdateExploratorySessionInput,
  canRunExploratoryAction,
  isOpenExploratory,
  isRecordingExploratory,
  sessionDurationSeconds,
  summarizeFindings,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
} from '../../errors';
import { AuditService } from '../audit/audit.service';
import { CustomFieldValuesService } from '../customization/custom-field-values.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { ExploratoryRepository, SessionRow } from './exploratory.repository';

const SESSION = 'Exploratory session';

const EVENT_OF: Record<ExploratoryAction, string> = {
  start: 'started',
  pause: 'paused',
  resume: 'resumed',
  complete: 'completed',
  cancel: 'cancelled',
  archive: 'archived',
};

type Session = NonNullable<Awaited<ReturnType<ExploratoryRepository['lock']>>>;

/**
 * Exploratory sessions (S7-F5). Every write locks the session row
 * (`FOR UPDATE`) and accepts an optional `version`; findings that become
 * defects also lock the finding, so one finding never yields two defects.
 * Completed and cancelled sessions are immutable, which the database enforces
 * with triggers as well.
 */
@Injectable()
export class ExploratoryService {
  constructor(
    private readonly sessions: ExploratoryRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly customValues: CustomFieldValuesService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListExploratorySessionsQuery): Promise<Paginated<ExploratorySessionView>> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return {
        data: [],
        meta: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 0 },
      };
    }
    const page = await this.sessions.list(query, {
      projectId,
      // Archived sessions are hidden unless asked for.
      status: query.status ?? { not: 'archived' },
      ...(query.ownerId === undefined ? {} : { ownerId: query.ownerId }),
      ...(query.environmentId === undefined ? {} : { environmentId: query.environmentId }),
      ...(query.releaseId === undefined ? {} : { releaseId: query.releaseId }),
      ...(query.testPlanId === undefined ? {} : { testPlanId: query.testPlanId }),
      ...(query.testCycleId === undefined ? {} : { testCycleId: query.testCycleId }),
    });
    return { data: page.data.map(toView), meta: page.meta };
  }

  async get(id: string): Promise<ExploratorySessionDetailView> {
    const row = await this.requireSession(id);
    const [findings, timeline, workItems, defects] = await Promise.all([
      this.sessions.findings(id),
      this.sessions.timeline(id),
      this.sessions.workItems(id),
      this.sessions.sessionDefects(id),
    ]);
    const users = new Map(
      (
        await this.sessions.users([
          ...new Set(
            [...findings.map((f) => f.createdById), ...timeline.map((e) => e.actorId)].filter(
              (value): value is string => value !== null,
            ),
          ),
        ])
      ).map((user) => [user.id, user]),
    );
    const seen = new Set<string>();
    const related: ExploratorySessionDetailView['defects'] = [];
    for (const finding of findings) {
      if (finding.defect !== null && !seen.has(finding.defect.id)) {
        seen.add(finding.defect.id);
        related.push({ ...finding.defect, source: 'finding' });
      }
    }
    for (const link of defects) {
      if (!seen.has(link.defect.id)) {
        seen.add(link.defect.id);
        related.push({ ...link.defect, source: 'session' });
      }
    }
    const view = toView(row);
    return {
      ...view,
      notes: row.notes,
      risks: row.risks,
      links: Array.isArray(row.links) ? (row.links as ExploratorySessionDetailView['links']) : [],
      findings: findings.map((finding) => ({
        id: finding.id,
        title: finding.title,
        description: finding.description,
        kind: finding.kind as FindingKind,
        severity: finding.severity,
        defect: finding.defect,
        defectCreated: finding.defectCreated,
        createdBy: finding.createdById === null ? null : (users.get(finding.createdById) ?? null),
        createdAt: finding.createdAt.toISOString(),
      })),
      timeline: timeline.map((event) => ({
        id: event.id,
        type: event.type as ExploratorySessionDetailView['timeline'][number]['type'],
        body: event.body,
        findingId: event.findingId,
        actor: event.actorId === null ? null : (users.get(event.actorId) ?? null),
        createdAt: event.createdAt.toISOString(),
      })),
      workItems: workItems.map((link) => link.workItem),
      defects: related,
      metrics: {
        durationSeconds: view.durationSeconds,
        timeboxMinutes: row.timeboxMinutes,
        notes: timeline.filter((event) => event.type === 'note').length,
        ...summarizeFindings(
          findings.map((finding) => ({
            kind: finding.kind as FindingKind,
            severity: finding.severity,
            defectId: finding.defectId,
            defectCreated: finding.defectCreated,
          })),
          defects.map((link) => link.defectId),
        ),
      },
    };
  }

  async create(
    input: CreateExploratorySessionInput,
    userId: string,
  ): Promise<ExploratorySessionDetailView> {
    const projectId = await this.access.authorizeProjectScope(input.projectId);
    if (projectId === null) {
      throw new NotFoundError('Project');
    }
    const id = await this.prisma.runInTransaction(async (tx) => {
      const ownerId = input.ownerId ?? userId;
      await this.assertOwner(projectId, ownerId, tx);
      const target = await this.resolveTarget(projectId, input, tx);
      const session = await this.sessions.create(
        {
          projectId,
          title: input.title,
          charter: input.charter,
          ownerId,
          ...target,
          timeboxMinutes: input.timeboxMinutes ?? null,
          links: input.links,
          createdById: userId,
        },
        tx,
      );
      await this.sessions.event(
        session,
        { type: 'created', body: input.charter, actorId: userId },
        tx,
      );
      await this.record(
        tx,
        AuditAction.create,
        session.id,
        `Created exploratory session ${session.title}`,
        {
          ownerId,
          ...target,
        },
      );
      return session.id;
    });
    return this.get(id);
  }

  async update(
    id: string,
    input: UpdateExploratorySessionInput,
    userId: string,
  ): Promise<ExploratorySessionDetailView> {
    const visible = await this.requireSession(id);
    await this.prisma
      .runInTransaction(async (tx) => {
        const current = await this.lockOpen(id, input.version, tx);
        if (input.ownerId !== undefined) {
          await this.assertOwner(visible.projectId, input.ownerId, tx);
        }
        const targetInput = {
          environmentId:
            input.environmentId === undefined ? current.environmentId : input.environmentId,
          releaseId: input.releaseId === undefined ? current.releaseId : input.releaseId,
          testPlanId: input.testPlanId === undefined ? current.testPlanId : input.testPlanId,
          testCycleId: input.testCycleId === undefined ? current.testCycleId : input.testCycleId,
        };
        const target = await this.resolveTarget(visible.projectId, targetInput, tx);
        const { version: _version, ...changes } = input;
        await this.sessions.update(
          id,
          {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.charter === undefined ? {} : { charter: input.charter }),
            ...(input.notes === undefined ? {} : { notes: input.notes }),
            ...(input.risks === undefined ? {} : { risks: input.risks }),
            ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
            ...(input.timeboxMinutes === undefined ? {} : { timeboxMinutes: input.timeboxMinutes }),
            ...(input.links === undefined ? {} : { links: input.links }),
            ...target,
          },
          tx,
        );
        await this.sessions.event(
          current,
          { type: 'updated', body: Object.keys(changes).join(', '), actorId: userId },
          tx,
        );
        await this.record(
          tx,
          AuditAction.update,
          id,
          `Updated exploratory session ${current.title}`,
          {
            fields: Object.keys(changes),
          },
        );
      })
      .catch(rethrowUnique);
    return this.get(id);
  }

  async transition(
    id: string,
    action: ExploratoryAction,
    input: ExploratoryActionInput,
    userId: string,
  ): Promise<ExploratorySessionDetailView> {
    await this.requireSession(id);
    const target = EXPLORATORY_ACTION_TARGET[action];
    await this.prisma
      .runInTransaction(async (tx) => {
        const current = await this.lockVersion(id, input.version, tx);
        const from = current.status as ExploratoryStatus;
        if (!canRunExploratoryAction(from, action)) {
          throw new InvalidStateTransitionError(SESSION, from, target);
        }
        const now = new Date();
        const data: Prisma.ExploratorySessionUncheckedUpdateInput = { status: target };
        const pausedSeconds =
          current.pausedSeconds +
          (current.pausedAt === null
            ? 0
            : Math.floor((now.getTime() - current.pausedAt.getTime()) / 1000));
        if (action === 'start') {
          data.startedAt = now;
        } else if (action === 'pause') {
          data.pausedAt = now;
        } else if (action === 'resume') {
          Object.assign(data, { pausedAt: null, pausedSeconds });
        } else if (action === 'complete' || action === 'cancel') {
          Object.assign(data, {
            pausedAt: null,
            pausedSeconds,
            endedAt: now,
            durationSeconds: sessionDurationSeconds(
              { startedAt: current.startedAt, endedAt: now, pausedAt: null, pausedSeconds },
              now,
            ),
          });
        } else {
          data.archivedAt = now;
        }
        await this.sessions.update(id, data, tx);
        await this.sessions.event(current, { type: EVENT_OF[action], actorId: userId }, tx);
        await this.record(
          tx,
          AuditAction.update,
          id,
          `Exploratory session ${current.title}: ${action}`,
          {
            status: { from, to: target },
          },
        );
      })
      .catch(rethrowUnique);
    return this.get(id);
  }

  async addNote(id: string, input: AddSessionNoteInput, userId: string) {
    await this.requireSession(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lockRecording(id, tx);
      await this.sessions.event(current, { type: 'note', body: input.body, actorId: userId }, tx);
      await this.sessions.update(id, {}, tx);
    });
    return this.get(id);
  }

  async addFinding(id: string, input: CreateFindingInput, userId: string) {
    await this.requireSession(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lockRecording(id, tx);
      const finding = await this.sessions.createFinding(
        current,
        {
          title: input.title,
          description: input.description ?? null,
          kind: input.kind,
          severity: input.severity,
          createdById: userId,
        },
        tx,
      );
      await this.sessions.event(
        current,
        {
          type: 'finding',
          body: `${input.severity} ${input.kind}: ${input.title}`,
          findingId: finding.id,
          actorId: userId,
        },
        tx,
      );
      await this.sessions.update(id, {}, tx);
      await this.record(tx, AuditAction.update, id, `Recorded finding ${input.title}`, {
        findingId: finding.id,
        kind: input.kind,
        severity: input.severity,
      });
    });
    return this.get(id);
  }

  /** A finding becomes a new defect of the session's project, once. */
  async convertFinding(id: string, findingId: string, input: ConvertFindingInput, userId: string) {
    const visible = await this.requireSession(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lockRecording(id, tx);
      const finding = await this.lockFindingFree(id, findingId, tx);
      const key = await this.projects.nextKey(visible.projectId, 'defectCounter', 'D', tx);
      const customFields = await this.customValues.resolve(
        visible.projectId,
        'defect',
        {},
        null,
        tx,
      );
      const defect = await tx.defect.create({
        data: {
          organizationId: current.organizationId,
          projectId: visible.projectId,
          key,
          title: input.title ?? finding.title,
          description: [finding.description, `Found in exploratory session "${current.title}".`]
            .filter((part) => part !== null && part !== '')
            .join('\n\n'),
          severity: finding.severity,
          priority: input.priority,
          environment: visible.environment?.name ?? null,
          reportedById: userId,
          customFields,
        },
      });
      await this.sessions.linkFindingDefect(finding.id, defect.id, true, tx);
      await this.sessions.event(
        current,
        {
          type: 'defect_created',
          body: `${defect.key} ${defect.title}`,
          findingId: finding.id,
          actorId: userId,
        },
        tx,
      );
      await this.sessions.update(id, {}, tx);
      await this.audit.record(
        {
          action: AuditAction.create,
          entityType: 'Defect',
          entityId: defect.id,
          summary: `Created ${defect.key} from exploratory finding ${finding.title}`,
          changes: { sessionId: id, findingId: finding.id },
        },
        tx,
      );
      await this.record(
        tx,
        AuditAction.update,
        id,
        `Finding ${finding.title} became ${defect.key}`,
        {
          findingId: finding.id,
          defectId: defect.id,
        },
      );
    });
    return this.get(id);
  }

  async linkFindingDefect(
    id: string,
    findingId: string,
    input: LinkSessionDefectInput,
    userId: string,
  ) {
    const visible = await this.requireSession(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lockRecording(id, tx);
      const finding = await this.lockFindingFree(id, findingId, tx);
      const defect = await this.sessions.findDefect(visible.projectId, input.defectId, tx);
      if (defect === null) {
        throw new NotFoundError('Defect');
      }
      await this.sessions.linkFindingDefect(finding.id, defect.id, false, tx);
      await this.sessions.event(
        current,
        {
          type: 'defect_linked',
          body: `${defect.key} ${defect.title}`,
          findingId: finding.id,
          actorId: userId,
        },
        tx,
      );
      await this.sessions.update(id, {}, tx);
      await this.record(
        tx,
        AuditAction.update,
        id,
        `Finding ${finding.title} related to ${defect.key}`,
        {
          findingId: finding.id,
          defectId: defect.id,
        },
      );
    });
    return this.get(id);
  }

  async linkWorkItem(id: string, workItemId: string, userId: string) {
    const visible = await this.requireSession(id);
    await this.prisma
      .runInTransaction(async (tx) => {
        const current = await this.lockOpen(id, undefined, tx);
        const item = await this.sessions.findWorkItem(visible.projectId, workItemId, tx);
        if (item === null) {
          throw new NotFoundError('Work item');
        }
        await this.sessions.linkWorkItem(current, item.id, tx);
        await this.sessions.event(
          current,
          { type: 'work_item_linked', body: `${item.key} ${item.title}`, actorId: userId },
          tx,
        );
        await this.sessions.update(id, {}, tx);
        await this.record(tx, AuditAction.update, id, `Linked ${item.key} to ${current.title}`, {
          workItemId,
        });
      })
      .catch(rethrowUnique);
    return this.get(id);
  }

  async unlinkWorkItem(id: string, workItemId: string, userId: string) {
    await this.requireSession(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lockOpen(id, undefined, tx);
      if ((await this.sessions.unlinkWorkItem(id, workItemId, tx)).count === 0) {
        throw new NotFoundError('Work item in session');
      }
      await this.sessions.event(
        current,
        { type: 'work_item_unlinked', body: workItemId, actorId: userId },
        tx,
      );
      await this.sessions.update(id, {}, tx);
      await this.record(tx, AuditAction.update, id, `Unlinked a work item from ${current.title}`, {
        workItemId,
      });
    });
    return this.get(id);
  }

  async linkDefect(id: string, defectId: string, userId: string) {
    const visible = await this.requireSession(id);
    await this.prisma
      .runInTransaction(async (tx) => {
        const current = await this.lockOpen(id, undefined, tx);
        const defect = await this.sessions.findDefect(visible.projectId, defectId, tx);
        if (defect === null) {
          throw new NotFoundError('Defect');
        }
        await this.sessions.linkDefect(current, defect.id, tx);
        await this.sessions.event(
          current,
          { type: 'defect_linked', body: `${defect.key} ${defect.title}`, actorId: userId },
          tx,
        );
        await this.sessions.update(id, {}, tx);
        await this.record(tx, AuditAction.update, id, `Related ${defect.key} to ${current.title}`, {
          defectId,
        });
      })
      .catch(rethrowUnique);
    return this.get(id);
  }

  async unlinkDefect(id: string, defectId: string, userId: string) {
    await this.requireSession(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lockOpen(id, undefined, tx);
      if ((await this.sessions.unlinkDefect(id, defectId, tx)).count === 0) {
        throw new NotFoundError('Defect in session');
      }
      await this.sessions.event(
        current,
        { type: 'defect_unlinked', body: defectId, actorId: userId },
        tx,
      );
      await this.sessions.update(id, {}, tx);
      await this.record(tx, AuditAction.update, id, `Unrelated a defect from ${current.title}`, {
        defectId,
      });
    });
    return this.get(id);
  }

  // --- internals -------------------------------------------------------------

  private async requireSession(id: string): Promise<SessionRow> {
    const row = await this.sessions.findById(id);
    if (row === null) {
      throw new NotFoundError(SESSION);
    }
    await this.access.assertRouteAccess(row.projectId, SESSION);
    return row;
  }

  private async lockVersion(
    id: string,
    version: number | undefined,
    tx: PrismaTransaction,
  ): Promise<Session> {
    const current = await this.sessions.lock(id, tx);
    if (current === null) {
      throw new NotFoundError(SESSION);
    }
    if (version !== undefined && version !== current.version) {
      throw new ConflictError('This session was changed by someone else; reload and try again', {
        version: current.version,
      });
    }
    return current;
  }

  private async lockOpen(id: string, version: number | undefined, tx: PrismaTransaction) {
    const current = await this.lockVersion(id, version, tx);
    if (!isOpenExploratory(current.status as ExploratoryStatus)) {
      throw new ConflictError(
        `Session ${current.title} is ${current.status} and can no longer be changed`,
      );
    }
    return current;
  }

  private async lockRecording(id: string, tx: PrismaTransaction) {
    const current = await this.lockVersion(id, undefined, tx);
    if (!isRecordingExploratory(current.status as ExploratoryStatus)) {
      throw new ConflictError(
        `Notes and findings are recorded while a session runs; ${current.title} is ${current.status}`,
      );
    }
    return current;
  }

  private async lockFindingFree(sessionId: string, findingId: string, tx: PrismaTransaction) {
    const finding = await this.sessions.lockFinding(sessionId, findingId, tx);
    if (finding === null) {
      throw new NotFoundError('Finding');
    }
    if (finding.defectId !== null) {
      throw new ConflictError('This finding is already related to a defect');
    }
    return finding;
  }

  private async assertOwner(projectId: string, ownerId: string, tx: PrismaTransaction) {
    const member = await this.sessions.findMember(ownerId, tx);
    if (member === null || !(await this.access.memberSees(projectId, ownerId, member.role))) {
      throw new ValidationError('The owner must be an active member who can see this project');
    }
  }

  /**
   * Environment, release, plan and cycle must live in the session's project;
   * a cycle must belong to the plan, and implies it when no plan is given.
   */
  private async resolveTarget(
    projectId: string,
    input: {
      environmentId?: string | null | undefined;
      releaseId?: string | null | undefined;
      testPlanId?: string | null | undefined;
      testCycleId?: string | null | undefined;
    },
    tx: PrismaTransaction,
  ) {
    const environmentId = input.environmentId ?? null;
    const releaseId = input.releaseId ?? null;
    let testPlanId = input.testPlanId ?? null;
    const testCycleId = input.testCycleId ?? null;
    if (
      environmentId !== null &&
      (await this.sessions.findEnvironment(projectId, environmentId, tx)) === null
    ) {
      throw new NotFoundError('Environment');
    }
    if (
      releaseId !== null &&
      (await this.sessions.findRelease(projectId, releaseId, tx)) === null
    ) {
      throw new NotFoundError('Release');
    }
    if (testPlanId !== null && (await this.sessions.findPlan(projectId, testPlanId, tx)) === null) {
      throw new NotFoundError('Test plan');
    }
    if (testCycleId !== null) {
      const cycle = await this.sessions.findCycle(projectId, testCycleId, tx);
      if (cycle === null) {
        throw new NotFoundError('Test cycle');
      }
      if (testPlanId !== null && cycle.testPlanId !== testPlanId) {
        throw new ValidationError('The test cycle belongs to another test plan');
      }
      testPlanId = cycle.testPlanId;
    }
    return { environmentId, releaseId, testPlanId, testCycleId };
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
        entityType: 'ExploratorySession',
        entityId,
        summary,
        changes: changes as Prisma.InputJsonValue,
      },
      tx,
    );
  }
}

/** One active session per tester and project (partial unique index). */
function rethrowUnique(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ConflictError(
      'Already linked, or the owner already runs another active session in this project',
    );
  }
  throw error;
}

function toView(row: SessionRow): ExploratorySessionView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    charter: row.charter,
    status: row.status as ExploratoryStatus,
    owner: row.owner,
    environment: row.environment,
    release: row.release,
    testPlan: row.testPlan,
    testCycle: row.testCycle,
    timeboxMinutes: row.timeboxMinutes,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    durationSeconds:
      row.durationSeconds ??
      sessionDurationSeconds({
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        pausedAt: row.pausedAt,
        pausedSeconds: row.pausedSeconds,
      }),
    findingCount: row._count.findings,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}
