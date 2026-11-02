import { Injectable } from '@nestjs/common';
import { AuditAction, CodeReviewDecision, OrganizationRole } from '@prisma/client';
import {
  CodeReviewDecisionInput,
  CodeReviewEventKind,
  CodeReviewSettingsInput,
  CodeReviewSettingsView,
  CodeReviewSummaryView,
  CodeReviewView,
  CreateCodeReviewInput,
  ListCodeReviewsQuery,
  Paginated,
  UpdateCodeReviewInput,
  buildPaginationMeta,
  computeCodeReviewStatus,
  computeMergeReadiness,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { DevelopmentService } from '../development/development.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { CodeReviewsRepository, ReviewWithRelations } from './code-reviews.repository';

const REVIEW = 'Code review';
const DEFAULT_REQUIRED_APPROVALS = 1;

/**
 * Code reviews (S5-F3). Reviews, pull requests and work items must be live,
 * in the same project and visible to the caller; anything else answers like
 * a missing id. Lock order: review, pull request, work items. Every decision
 * locks the review row, so concurrent decisions apply one at a time and the
 * stored status always matches the decisions.
 */
@Injectable()
export class CodeReviewsService {
  constructor(
    private readonly repo: CodeReviewsRepository,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly development: DevelopmentService,
  ) {}

  async create(input: CreateCodeReviewInput, userId: string): Promise<CodeReviewView> {
    const projectId = await this.requireProject(input.projectId);
    const reviewerIds = [...new Set(input.reviewerIds)];
    if (reviewerIds.includes(userId)) {
      throw new ValidationError('The author cannot review their own change');
    }
    await this.assertReviewers(projectId, reviewerIds);
    const workItemIds = [...new Set(input.workItemIds)].sort();
    const id = await this.prisma.runInTransaction(async (tx) => {
      if (
        input.pullRequestId !== undefined &&
        !(await this.repo.lockPullRequest(projectId, input.pullRequestId, tx))
      ) {
        throw new NotFoundError('Pull request');
      }
      const items = await this.repo.lockWorkItems(projectId, workItemIds, tx);
      if (items.length !== workItemIds.length) {
        throw new NotFoundError('Work item');
      }
      const before = await this.development.captureStatuses(items, tx);
      const row = await this.repo.create(
        {
          projectId,
          title: input.title,
          summary: input.summary ?? null,
          authorId: userId,
          pullRequestId: input.pullRequestId ?? null,
          requiredApprovals: input.requiredApprovals ?? null,
        },
        tx,
      );
      for (const reviewerId of reviewerIds) {
        await this.repo.addReviewer(projectId, row.id, reviewerId, tx);
      }
      for (const item of items) {
        await this.repo.link(projectId, row.id, item.id, userId, tx);
      }
      await this.repo.event(projectId, row.id, { kind: 'created', actorId: userId }, tx);
      await this.audit.record(
        {
          action: AuditAction.create,
          entityType: 'CodeReview',
          entityId: row.id,
          summary: `Opened code review "${row.title}"`,
          changes: { reviewerIds, workItemIds, pullRequestId: row.pullRequestId },
        },
        tx,
      );
      await this.development.auditStatusChanges(items, before, tx);
      return row.id;
    });
    return this.get(id);
  }

  async list(
    query: ListCodeReviewsQuery,
    userId: string,
  ): Promise<Paginated<CodeReviewSummaryView>> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return { data: [], meta: buildPaginationMeta(query, 0) };
    }
    const me = (value: string | undefined) => (value === 'me' ? userId : value);
    const page = await this.repo.list(query, {
      projectId,
      status: query.status,
      reviewerId: me(query.reviewerId),
      authorId: me(query.authorId),
      workItemId: query.workItemId,
      pullRequestId: query.pullRequestId,
      search: query.search,
    });
    const views = await this.toViews(page.data);
    return { data: views, meta: page.meta };
  }

  async get(id: string): Promise<CodeReviewView> {
    const row = await this.findVisible(id);
    const [summary] = await this.toViews([row]);
    const events = await this.repo.events(row.id);
    const names = await this.names(events.flatMap((event) => [event.actorId, event.subjectId]));
    const ref = (userId: string | null) =>
      userId === null || !names.has(userId)
        ? null
        : { id: userId, fullName: names.get(userId) ?? '' };
    return {
      ...summary!,
      summary: row.summary,
      requiredApprovals: row.requiredApprovals,
      provider: row.provider,
      externalId: row.externalId,
      workItems: row.workItems.map(({ workItem }) => ({
        id: workItem.id,
        key: workItem.key,
        title: workItem.title,
        status: workItem.status,
      })),
      events: events.map((event) => ({
        id: event.id,
        kind: event.kind as CodeReviewEventKind,
        actor: ref(event.actorId),
        subject: ref(event.subjectId),
        comment: event.comment,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  async forWorkItem(workItemId: string): Promise<CodeReviewSummaryView[]> {
    const item = await this.prisma.scoped.workItem.findFirst({
      where: { id: workItemId, deletedAt: null },
    });
    if (item === null || (await this.access.authorizeProjectScope(item.projectId)) === null) {
      throw new NotFoundError('Work item');
    }
    const page = await this.repo.list(
      { page: 1, pageSize: 100 },
      { projectId: item.projectId, workItemId },
    );
    return this.toViews(page.data);
  }

  async update(id: string, input: UpdateCodeReviewInput, userId: string): Promise<CodeReviewView> {
    await this.mutate(id, input.version, async (row, tx) => {
      this.assertOpen(row);
      const data = {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.requiredApprovals === undefined
          ? {}
          : { requiredApprovals: input.requiredApprovals }),
      };
      await this.repo.update(row.id, data, tx);
      await this.repo.event(row.projectId, row.id, { kind: 'updated', actorId: userId }, tx);
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'CodeReview',
          entityId: row.id,
          summary: `Updated code review "${row.title}"`,
          changes: data,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async remove(id: string, userId: string): Promise<void> {
    await this.mutate(
      id,
      undefined,
      async (row, tx) => {
        await this.repo.update(row.id, { deletedAt: new Date() }, tx);
        await this.repo.event(row.projectId, row.id, { kind: 'deleted', actorId: userId }, tx);
        await this.audit.record(
          {
            action: AuditAction.delete,
            entityType: 'CodeReview',
            entityId: row.id,
            summary: `Deleted code review "${row.title}"`,
          },
          tx,
        );
      },
      { recompute: false },
    );
  }

  async addReviewer(id: string, reviewerId: string, userId: string): Promise<CodeReviewView> {
    const row = await this.findVisible(id);
    if (reviewerId === row.authorId) {
      throw new ValidationError('The author cannot review their own change');
    }
    await this.assertReviewers(row.projectId, [reviewerId]);
    await this.mutate(id, undefined, async (locked, tx) => {
      this.assertOpen(locked);
      if (await this.repo.addReviewer(locked.projectId, locked.id, reviewerId, tx)) {
        await this.repo.event(
          locked.projectId,
          locked.id,
          { kind: 'reviewer_added', actorId: userId, subjectId: reviewerId },
          tx,
        );
        await this.audit.record(
          {
            action: AuditAction.update,
            entityType: 'CodeReview',
            entityId: locked.id,
            summary: `Added a reviewer to "${locked.title}"`,
            changes: { reviewerAdded: reviewerId },
          },
          tx,
        );
      }
    });
    return this.get(id);
  }

  async removeReviewer(id: string, reviewerId: string, userId: string): Promise<void> {
    await this.mutate(id, undefined, async (row, tx) => {
      this.assertOpen(row);
      if (await this.repo.removeReviewer(row.id, reviewerId, tx)) {
        await this.repo.event(
          row.projectId,
          row.id,
          { kind: 'reviewer_removed', actorId: userId, subjectId: reviewerId },
          tx,
        );
        await this.audit.record(
          {
            action: AuditAction.update,
            entityType: 'CodeReview',
            entityId: row.id,
            summary: `Removed a reviewer from "${row.title}"`,
            changes: { reviewerRemoved: reviewerId },
          },
          tx,
        );
      }
    });
  }

  /** Approve, request changes or revoke the caller's own decision. */
  async decide(
    id: string,
    input: CodeReviewDecisionInput,
    userId: string,
  ): Promise<CodeReviewView> {
    await this.mutate(id, undefined, async (row, tx) => {
      this.assertOpen(row);
      if (row.authorId === userId) {
        throw new ForbiddenError('The author cannot review their own change');
      }
      const reviewer = (await this.repo.reviewers(row.id, tx)).find(
        (entry) => entry.userId === userId,
      );
      if (reviewer === undefined) {
        throw new ForbiddenError('Only an assigned reviewer can decide on this review');
      }
      const target: CodeReviewDecision =
        input.decision === 'approve'
          ? 'approved'
          : input.decision === 'request_changes'
            ? 'changes_requested'
            : 'pending';
      if (reviewer.decision === target) {
        throw new ConflictError(
          target === 'approved'
            ? 'You already approved this review'
            : target === 'changes_requested'
              ? 'You already requested changes'
              : 'You have no decision to revoke',
        );
      }
      await this.repo.setDecision(reviewer.id, target, input.comment ?? null, tx);
      const kind =
        target === 'approved'
          ? 'approved'
          : target === 'changes_requested'
            ? 'changes_requested'
            : 'decision_revoked';
      await this.repo.event(
        row.projectId,
        row.id,
        { kind, actorId: userId, comment: input.comment ?? null },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'CodeReview',
          entityId: row.id,
          summary: `${kind.replace('_', ' ')} on "${row.title}"`,
          changes: { decision: { from: reviewer.decision, to: target } },
        },
        tx,
      );
    });
    return this.get(id);
  }

  /** Dismiss the approval (or change request) of one reviewer. */
  async dismissDecision(
    id: string,
    reviewerId: string,
    comment: string | undefined,
    userId: string,
  ): Promise<CodeReviewView> {
    await this.mutate(id, undefined, async (row, tx) => {
      this.assertOpen(row);
      const reviewer = (await this.repo.reviewers(row.id, tx)).find(
        (entry) => entry.userId === reviewerId,
      );
      if (reviewer === undefined) {
        throw new NotFoundError('Reviewer');
      }
      if (reviewer.decision !== 'approved' && reviewer.decision !== 'changes_requested') {
        throw new ConflictError('The reviewer has no decision to dismiss');
      }
      await this.repo.setDecision(reviewer.id, 'dismissed', comment ?? null, tx);
      await this.repo.event(
        row.projectId,
        row.id,
        {
          kind: 'approval_dismissed',
          actorId: userId,
          subjectId: reviewerId,
          comment: comment ?? null,
        },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'CodeReview',
          entityId: row.id,
          summary: `Dismissed a decision on "${row.title}"`,
          changes: { decision: { reviewerId, from: reviewer.decision, to: 'dismissed' } },
        },
        tx,
      );
    });
    return this.get(id);
  }

  async dismiss(id: string, comment: string | undefined, userId: string): Promise<CodeReviewView> {
    await this.mutate(
      id,
      undefined,
      async (row, tx) => {
        this.assertOpen(row);
        await this.repo.update(row.id, { status: 'dismissed' }, tx);
        await this.repo.event(
          row.projectId,
          row.id,
          { kind: 'dismissed', actorId: userId, comment: comment ?? null },
          tx,
        );
        await this.audit.record(
          {
            action: AuditAction.update,
            entityType: 'CodeReview',
            entityId: row.id,
            summary: `Dismissed code review "${row.title}"`,
            changes: { status: { from: row.status, to: 'dismissed' } },
          },
          tx,
        );
      },
      { recompute: false },
    );
    return this.get(id);
  }

  async comment(id: string, comment: string, userId: string): Promise<CodeReviewView> {
    await this.mutate(
      id,
      undefined,
      async (row, tx) => {
        await this.repo.event(
          row.projectId,
          row.id,
          { kind: 'commented', actorId: userId, comment },
          tx,
        );
      },
      { recompute: false },
    );
    return this.get(id);
  }

  async link(id: string, workItemId: string, userId: string): Promise<{ created: boolean }> {
    let created = false;
    await this.mutate(
      id,
      undefined,
      async (row, tx) => {
        const items = await this.repo.lockWorkItems(row.projectId, [workItemId], tx);
        if (items.length !== 1) {
          throw new NotFoundError('Work item');
        }
        const before = await this.development.captureStatuses(items, tx);
        created = await this.repo.link(row.projectId, row.id, workItemId, userId, tx);
        if (created) {
          await this.repo.event(
            row.projectId,
            row.id,
            { kind: 'work_item_linked', actorId: userId, comment: items[0]!.key },
            tx,
          );
          await this.audit.record(
            {
              action: AuditAction.create,
              entityType: 'CodeReviewWorkItem',
              entityId: row.id,
              summary: `Linked ${items[0]!.key} to code review "${row.title}"`,
            },
            tx,
          );
          await this.development.auditStatusChanges(items, before, tx);
        }
      },
      { recompute: false },
    );
    return { created };
  }

  async unlink(id: string, workItemId: string, userId: string): Promise<void> {
    await this.mutate(
      id,
      undefined,
      async (row, tx) => {
        const items = await this.repo.lockWorkItems(row.projectId, [workItemId], tx);
        const before = await this.development.captureStatuses(items, tx);
        if (await this.repo.unlink(row.id, workItemId, tx)) {
          const key = items[0]?.key ?? workItemId;
          await this.repo.event(
            row.projectId,
            row.id,
            { kind: 'work_item_unlinked', actorId: userId, comment: key },
            tx,
          );
          await this.audit.record(
            {
              action: AuditAction.delete,
              entityType: 'CodeReviewWorkItem',
              entityId: row.id,
              summary: `Unlinked ${key} from code review "${row.title}"`,
            },
            tx,
          );
          await this.development.auditStatusChanges(items, before, tx);
        }
      },
      { recompute: false },
    );
  }

  async settings(projectId: string): Promise<CodeReviewSettingsView> {
    const authorized = await this.requireProject(projectId);
    const row = await this.repo.setting(authorized);
    return {
      projectId: authorized,
      requiredApprovals: row?.requiredApprovals ?? DEFAULT_REQUIRED_APPROVALS,
    };
  }

  async updateSettings(
    input: CodeReviewSettingsInput,
    userId: string,
  ): Promise<CodeReviewSettingsView> {
    const projectId = await this.requireProject(input.projectId);
    await this.prisma.runInTransaction(async (tx) => {
      await this.repo.upsertSetting(projectId, input.requiredApprovals, userId, tx);
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'CodeReviewSetting',
          entityId: projectId,
          summary: `Code reviews now need ${input.requiredApprovals} approval(s)`,
          changes: { requiredApprovals: input.requiredApprovals },
        },
        tx,
      );
    });
    return this.settings(projectId);
  }

  // --- internals -------------------------------------------------------------

  private async requireProject(projectId: string): Promise<string> {
    const authorized = await this.access.authorizeProjectScope(projectId);
    if (authorized === null) {
      throw new NotFoundError('Project');
    }
    return authorized;
  }

  private async findVisible(id: string, tx?: PrismaTransaction): Promise<ReviewWithRelations> {
    const row = await this.repo.find(id, tx);
    if (row === null || (await this.access.authorizeProjectScope(row.projectId)) === null) {
      throw new NotFoundError(REVIEW);
    }
    return row;
  }

  private assertOpen(row: { status: string }): void {
    if (row.status === 'dismissed') {
      throw new ConflictError('The review was dismissed');
    }
  }

  /** Every reviewer must be an active member who can review in the project. */
  private async assertReviewers(projectId: string, userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    const members = await this.repo.members(userIds);
    for (const userId of userIds) {
      const member = members.find((entry) => entry.userId === userId);
      if (
        member === undefined ||
        !(await this.access.memberHasPermission(
          projectId,
          userId,
          member.role,
          'code_reviews.review',
        ))
      ) {
        throw new ValidationError(
          'Every reviewer must have access to the project and may review code',
        );
      }
    }
  }

  /**
   * Locks the review, checks `version`, runs `change`, then recomputes the
   * stored status from the decisions and audits development status changes
   * of the linked work items.
   */
  private async mutate(
    id: string,
    version: number | undefined,
    change: (row: ReviewWithRelations, tx: PrismaTransaction) => Promise<void>,
    options: { recompute?: boolean } = {},
  ): Promise<void> {
    await this.findVisible(id);
    await this.prisma.runInTransaction(async (tx) => {
      if ((await this.repo.lock(id, tx)) === null) {
        throw new NotFoundError(REVIEW);
      }
      const row = await this.findVisible(id, tx);
      if (version !== undefined && row.version !== version) {
        throw new ConflictError('The review changed since you loaded it');
      }
      const items = await this.repo.linkedWorkItems(row.id, tx);
      const before = await this.development.captureStatuses(items, tx);
      await change(row, tx);
      if (options.recompute !== false) {
        const current = await this.repo.find(row.id, tx);
        if (current !== null) {
          const required =
            current.requiredApprovals ??
            (await this.repo.setting(row.projectId))?.requiredApprovals ??
            DEFAULT_REQUIRED_APPROVALS;
          const status = computeCodeReviewStatus(
            current.reviewers.map((reviewer) => reviewer.decision),
            required,
            current.status === 'dismissed',
          );
          if (status !== current.status) {
            await tx.codeReview.update({ where: { id: row.id }, data: { status } });
          }
        }
      }
      await this.development.auditStatusChanges(items, before, tx);
    });
  }

  private async names(ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    const users = unique.length === 0 ? [] : await this.repo.users(unique);
    return new Map(users.map((user) => [user.id, user.fullName]));
  }

  private async toViews(rows: ReviewWithRelations[]): Promise<CodeReviewSummaryView[]> {
    const userIds = rows.flatMap((row) => [
      row.authorId,
      ...row.reviewers.map((reviewer) => reviewer.userId),
    ]);
    const [names, members] = await Promise.all([
      this.names(userIds),
      this.repo.members([...new Set(userIds)]),
    ]);
    const setting = rows[0] === undefined ? null : await this.repo.setting(rows[0].projectId);
    const roleOf = new Map(members.map((member) => [member.userId, member.role]));
    const views: CodeReviewSummaryView[] = [];
    for (const row of rows) {
      const reviewers = [];
      for (const reviewer of row.reviewers) {
        const role: OrganizationRole | undefined = roleOf.get(reviewer.userId);
        const canReview =
          role !== undefined &&
          (await this.access.memberHasPermission(
            row.projectId,
            reviewer.userId,
            role,
            'code_reviews.review',
          ));
        reviewers.push({
          user: { id: reviewer.userId, fullName: names.get(reviewer.userId) ?? 'Unknown user' },
          decision: reviewer.decision,
          comment: reviewer.comment,
          decidedAt: reviewer.decidedAt?.toISOString() ?? null,
          canReview,
        });
      }
      const pullRequest =
        row.pullRequest !== null && row.pullRequest.deletedAt === null ? row.pullRequest : null;
      views.push({
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        status: row.status,
        author: { id: row.authorId, fullName: names.get(row.authorId) ?? 'Unknown user' },
        pullRequest:
          pullRequest === null
            ? null
            : {
                id: pullRequest.id,
                prNumber: pullRequest.prNumber,
                title: pullRequest.title,
                status: pullRequest.status,
                url: pullRequest.url,
              },
        reviewers,
        mergeReadiness: computeMergeReadiness({
          dismissed: row.status === 'dismissed',
          reviewers,
          requiredApprovals:
            row.requiredApprovals ?? setting?.requiredApprovals ?? DEFAULT_REQUIRED_APPROVALS,
          pullRequestStatus: pullRequest?.status,
        }),
        version: row.version,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    return views;
  }
}
