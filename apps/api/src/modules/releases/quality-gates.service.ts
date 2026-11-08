import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import {
  CreateQualityGateInput,
  EvaluateQualityGatesQuery,
  GATE_CRITICAL_SEVERITIES,
  GATE_HIGH_SEVERITIES,
  GateResult,
  ListQualityGatesQuery,
  OverrideQualityGatesInput,
  QualityGateEvaluation,
  QualityGateFacts,
  QualityGateRuleType,
  QualityGateView,
  ReleaseQualityGatesView,
  UpdateQualityGateInput,
  combineGateResults,
  evaluateQualityGateRule,
  gateAllowsDeployment,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import {
  ConflictError,
  DuplicateResourceError,
  NotFoundError,
  QualityGateFailedError,
} from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { QualityGatesRepository } from './quality-gates.repository';
import { ReleasesRepository } from './releases.repository';

const GATE = 'QualityGate';
type GateRow = NonNullable<Awaited<ReturnType<QualityGatesRepository['find']>>>;

export interface EnvironmentGates {
  gates: QualityGateEvaluation[];
  required: { result: GateResult; gateCount: number };
  override: Awaited<ReturnType<QualityGatesRepository['latestOverride']>>;
}

/**
 * Quality gates (S6-F3). Gates are configuration; results are evaluated
 * against the current data of a release on every read (one REPEATABLE READ
 * snapshot) and inside the deployment transaction when a release is about
 * to enter a protected environment. Overrides are append-only rows.
 */
@Injectable()
export class QualityGatesService {
  constructor(
    private readonly gates: QualityGatesRepository,
    private readonly releases: ReleasesRepository,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListQualityGatesQuery): Promise<QualityGateView[]> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return [];
    }
    return (await this.gates.list(projectId, query.environmentId)).map(toView);
  }

  async get(id: string): Promise<QualityGateView> {
    return toView(await this.requireVisible(id));
  }

  async create(input: CreateQualityGateInput, userId: string): Promise<QualityGateView> {
    const projectId = await this.access.authorizeProjectScope(input.projectId);
    if (projectId === null) {
      throw new NotFoundError('Project');
    }
    const id = await this.unique(() =>
      this.prisma.runInTransaction(async (tx) => {
        if (
          input.environmentId !== undefined &&
          (await this.gates.lockEnvironment(projectId, input.environmentId, tx)) === null
        ) {
          throw new NotFoundError('Environment');
        }
        const gate = await this.gates.create(
          {
            projectId,
            name: input.name,
            description: input.description ?? null,
            environmentId: input.environmentId ?? null,
            required: input.required,
            enabled: input.enabled,
            createdById: userId,
          },
          input.rules.map((rule) => ({ type: rule.type, threshold: rule.threshold ?? null })),
          tx,
        );
        await this.record(tx, AuditAction.create, gate.id, `Created quality gate ${gate.name}`, {
          rules: input.rules.map((rule) => ({
            type: rule.type,
            threshold: rule.threshold ?? null,
          })),
          environmentId: gate.environmentId,
          required: gate.required,
        });
        return gate.id;
      }),
    );
    return this.get(id);
  }

  async update(id: string, input: UpdateQualityGateInput): Promise<QualityGateView> {
    await this.requireVisible(id);
    await this.unique(() =>
      this.prisma.runInTransaction(async (tx) => {
        const current = await this.gates.lockForUpdate(id, tx);
        if (current === null) {
          throw new NotFoundError(GATE);
        }
        if (input.version !== undefined && input.version !== current.version) {
          throw new ConflictError(
            'This quality gate was changed by someone else; reload and try again',
            { version: current.version },
          );
        }
        if (
          input.environmentId !== undefined &&
          input.environmentId !== null &&
          (await this.gates.lockEnvironment(current.projectId, input.environmentId, tx)) === null
        ) {
          throw new NotFoundError('Environment');
        }
        await this.gates.update(
          id,
          {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
            ...(input.required === undefined ? {} : { required: input.required }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          },
          tx,
        );
        if (input.rules !== undefined) {
          await this.gates.replaceRules(
            id,
            current.projectId,
            input.rules.map((rule) => ({ type: rule.type, threshold: rule.threshold ?? null })),
            tx,
          );
        }
        const { version: _version, ...changes } = input;
        await this.record(tx, AuditAction.update, id, `Updated quality gate ${current.name}`, {
          ...changes,
          previousRules: current.rules.map((rule) => ({
            type: rule.type,
            threshold: rule.threshold,
          })),
        });
      }),
    );
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    await this.requireVisible(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.gates.lockForUpdate(id, tx);
      if (current === null) {
        throw new NotFoundError(GATE);
      }
      await this.gates.update(id, { deletedAt: new Date() }, tx);
      await this.record(tx, AuditAction.delete, id, `Deleted quality gate ${current.name}`, {
        name: current.name,
      });
    });
  }

  /** Evaluates the gates of a release, for one environment or only project-wide ones. */
  async evaluate(
    releaseId: string,
    query: EvaluateQualityGatesQuery,
  ): Promise<ReleaseQualityGatesView> {
    const release = await this.requireRelease(releaseId);
    return this.prisma.runInTransaction(
      async (tx) => {
        const environment =
          query.environmentId === undefined
            ? null
            : await this.gates.findEnvironment(release.projectId, query.environmentId, tx);
        if (query.environmentId !== undefined && environment === null) {
          throw new NotFoundError('Environment');
        }
        const facts = await this.facts(release.projectId, release.id, tx);
        const evaluated = await this.forEnvironment(
          release.projectId,
          release.id,
          environment?.id ?? null,
          facts,
          tx,
        );
        const by =
          evaluated.override === null
            ? null
            : await this.gates.user(evaluated.override.createdById, tx);
        return {
          release: { id: release.id, name: release.name, version: release.version },
          environment,
          gates: evaluated.gates,
          required: evaluated.required,
          override:
            evaluated.override === null
              ? null
              : {
                  id: evaluated.override.id,
                  reason: evaluated.override.reason,
                  gateStatus: evaluated.override.gateStatus,
                  createdAt: evaluated.override.createdAt.toISOString(),
                  createdBy: by,
                },
          deployable:
            gateAllowsDeployment(evaluated.required.result) || evaluated.override !== null,
          evaluatedAt: new Date().toISOString(),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /** Manual override of the required gates of a release in an environment; audited. */
  async override(
    releaseId: string,
    input: OverrideQualityGatesInput,
    userId: string,
  ): Promise<ReleaseQualityGatesView> {
    const release = await this.requireRelease(releaseId);
    await this.prisma.runInTransaction(async (tx) => {
      await this.releases.lock(release.id, 'share', tx);
      const environment = await this.gates.lockEnvironment(
        release.projectId,
        input.environmentId,
        tx,
      );
      if (environment === null) {
        throw new NotFoundError('Environment');
      }
      const facts = await this.facts(release.projectId, release.id, tx);
      const evaluated = await this.forEnvironment(
        release.projectId,
        release.id,
        environment.id,
        facts,
        tx,
      );
      if (gateAllowsDeployment(evaluated.required.result)) {
        throw new ConflictError(
          `The required quality gates of ${environment.name} already let the release in; nothing to override`,
        );
      }
      const id = await this.gates.createOverride(
        {
          projectId: release.projectId,
          releaseId: release.id,
          environmentId: environment.id,
          reason: input.reason,
          gateStatus: evaluated.required.result,
          createdById: userId,
        },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.create,
          entityType: 'QualityGateOverride',
          entityId: id,
          summary: `Overrode quality gates of release ${release.version} for ${environment.name}`,
          changes: {
            releaseId: release.id,
            environmentId: environment.id,
            reason: input.reason,
            gateStatus: evaluated.required.result,
            failing: failingRules(evaluated.gates),
          },
        },
        tx,
      );
    });
    return this.evaluate(releaseId, { environmentId: input.environmentId });
  }

  /**
   * Called inside the deployment transaction before a release starts in a
   * protected environment: required gates must pass or be overridden.
   */
  async assertDeployable(
    projectId: string,
    releaseId: string | null,
    environment: { id: string; name: string },
    tx: PrismaTransaction,
  ): Promise<void> {
    const applicable = (await this.gates.applicable(projectId, environment.id, tx)).filter(
      (gate) => gate.required,
    );
    if (applicable.length === 0) {
      return;
    }
    if (releaseId === null) {
      throw new QualityGateFailedError(
        `Environment ${environment.name} has required quality gates: a deployment there needs a release`,
      );
    }
    const facts = await this.facts(projectId, releaseId, tx);
    const evaluated = await this.forEnvironment(projectId, releaseId, environment.id, facts, tx);
    if (gateAllowsDeployment(evaluated.required.result) || evaluated.override !== null) {
      return;
    }
    const failing = failingRules(evaluated.gates);
    throw new QualityGateFailedError(
      `Required quality gates of ${environment.name} are ${evaluated.required.result}: ${failing
        .map((rule) => `${rule.gate}: ${rule.message}`)
        .join('; ')}`,
      { result: evaluated.required.result, failing },
    );
  }

  /** Gates applicable in one environment, evaluated against the facts, plus its override. */
  async forEnvironment(
    projectId: string,
    releaseId: string,
    environmentId: string | null,
    facts: QualityGateFacts,
    tx: PrismaTransaction,
  ): Promise<EnvironmentGates> {
    const rows = await this.gates.applicable(projectId, environmentId, tx);
    const gates = rows.map((row) => evaluateGate(row, facts));
    const required = gates.filter((entry) => entry.gate.required);
    return {
      gates,
      required: {
        result: combineGateResults(required.map((entry) => entry.result)),
        gateCount: required.length,
      },
      override:
        environmentId === null
          ? null
          : await this.gates.latestOverride(releaseId, environmentId, tx),
    };
  }

  /** Everything the rules look at, read through the given transaction. */
  async facts(
    projectId: string,
    releaseId: string,
    tx: PrismaTransaction,
  ): Promise<QualityGateFacts> {
    const [runs, cases, requirements, critical, high, build, reviews] = await Promise.all([
      this.releases.runCounts(releaseId, tx),
      this.releases.caseStatuses(releaseId, tx),
      this.releases.requirementCases(projectId, tx),
      this.releases.blockingDefects(releaseId, GATE_CRITICAL_SEVERITIES, tx),
      this.releases.blockingDefects(releaseId, GATE_HIGH_SEVERITIES, tx),
      this.releases.latestBuild(projectId, releaseId, tx),
      this.releases.releaseReviews(projectId, releaseId, tx),
    ]);
    const count = (status: string) => cases.filter((row) => row.status === status).length;
    const byRequirement = new Map<string, { key: string; covered: boolean }>();
    for (const row of requirements) {
      const entry = byRequirement.get(row.requirementId) ?? {
        key: row.requirementKey,
        covered: false,
      };
      entry.covered ||= row.testCaseId !== null;
      byRequirement.set(row.requirementId, entry);
    }
    const all = [...byRequirement.entries()];
    return {
      cases: {
        total: cases.length,
        executed: cases.length - count('untested'),
        passed: count('passed'),
        failed: count('failed'),
        blocked: count('blocked'),
      },
      runs: runs.map((run) => ({
        id: run.id,
        name: run.name,
        status: run.status,
        failed: run.counts.failed,
        blocked: run.counts.blocked,
      })),
      requirements: {
        total: all.length,
        covered: all.filter(([, entry]) => entry.covered).length,
        uncovered: all
          .filter(([, entry]) => !entry.covered)
          .map(([id, entry]) => ({ id, key: entry.key })),
      },
      defects: {
        critical: critical.map(({ id, key, title }) => ({ id, key, title })),
        high: high.map(({ id, key, title }) => ({ id, key, title })),
      },
      build,
      reviews,
    };
  }

  private async requireRelease(id: string) {
    const release = await this.releases.findById(id);
    if (release === null) {
      throw new NotFoundError('Release');
    }
    await this.access.assertRouteAccess(release.projectId, 'Release');
    return release;
  }

  private async requireVisible(id: string): Promise<GateRow> {
    const row = await this.gates.find(id);
    if (row === null || (await this.access.authorizeProjectScope(row.projectId)) === null) {
      throw new NotFoundError(GATE);
    }
    return row;
  }

  private async unique<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateResourceError('quality gate', 'name');
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
      { action, entityType: GATE, entityId, summary, changes: changes as Prisma.InputJsonValue },
      tx,
    );
  }
}

function toView(row: GateRow): QualityGateView {
  return {
    id: row.id,
    projectId: row.projectId,
    environment: row.environment,
    name: row.name,
    description: row.description,
    required: row.required,
    enabled: row.enabled,
    version: row.version,
    rules: row.rules.map((rule) => ({
      type: rule.type as QualityGateRuleType,
      threshold: rule.threshold,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function evaluateGate(row: GateRow, facts: QualityGateFacts): QualityGateEvaluation {
  const gate = toView(row);
  const rules = gate.rules.map((rule) => evaluateQualityGateRule(rule, facts));
  return { gate, result: combineGateResults(rules.map((rule) => rule.result)), rules };
}

function failingRules(gates: readonly QualityGateEvaluation[]) {
  return gates
    .filter((entry) => entry.gate.required)
    .flatMap((entry) =>
      entry.rules
        .filter((rule) => rule.result === 'failed' || rule.result === 'pending')
        .map((rule) => ({
          gate: entry.gate.name,
          type: rule.type,
          result: rule.result,
          message: rule.message,
        })),
    );
}
