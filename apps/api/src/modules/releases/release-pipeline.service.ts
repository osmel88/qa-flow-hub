import { Injectable } from '@nestjs/common';
import { DevelopmentArtifact, Environment, Prisma } from '@prisma/client';
import {
  BLOCKING_DEFECT_SEVERITIES,
  DeploymentStatus,
  EnvironmentKind,
  EnvironmentStatus,
  PROTECTED_ENVIRONMENT_PERMISSION,
  PipelineDeploymentRef,
  PipelineEnvironmentRef,
  ReleasePipelineQuery,
  ReleasePipelineStage,
  ReleasePipelineView,
  TestResultStatus,
  computePipelineStages,
  computePipelineStatus,
  computeQaResult,
} from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import { ForbiddenError, NotFoundError } from '../../errors';
import { ProjectAccessService } from '../projects/project-access.service';
import { EnvironmentGates, QualityGatesService } from './quality-gates.service';
import { ReleasesRepository } from './releases.repository';
import { statusCounts, toReleaseView } from './releases.service';

/**
 * Release pipeline (S6-F2). Read-only and derived: every read takes one
 * REPEATABLE READ snapshot, so a stage, its last deployment and the counts
 * always agree even while deployments move. Stages are the active and
 * inactive environments of the release's project in environment order;
 * archived environments appear only as history.
 */
@Injectable()
export class ReleasePipelineService {
  constructor(
    private readonly releases: ReleasesRepository,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly gates: QualityGatesService,
  ) {}

  async pipeline(id: string, query: ReleasePipelineQuery): Promise<ReleasePipelineView> {
    const found = await this.releases.findById(id);
    if (found === null) {
      throw new NotFoundError('Release');
    }
    await this.access.assertRouteAccess(found.projectId, 'Release');
    const projectId = found.projectId;
    const held = await this.access.effectivePermissions(projectId);
    if (!held.has('work_items.read')) {
      throw new ForbiddenError('Seeing the release pipeline needs work_items.read');
    }

    const data = await this.prisma.runInTransaction(
      async (tx) => {
        const release = await this.releases.findById(id, tx);
        if (release === null) {
          throw new NotFoundError('Release');
        }
        const [environments, deployments, build, runs, cases, defects, blocking] =
          await Promise.all([
            this.releases.pipelineEnvironments(projectId, tx),
            this.releases.releaseDeployments(projectId, id, tx),
            this.releases.latestPassedBuild(projectId, id, tx),
            this.releases.runCounts(id, tx),
            this.releases.caseStatuses(id, tx),
            this.releases.defectCounts(id, tx),
            this.releases.blockingDefects(id, BLOCKING_DEFECT_SEVERITIES, tx),
          ]);
        const facts = await this.gates.facts(projectId, id, tx);
        const gateResults = new Map<string, EnvironmentGates>();
        for (const env of environments.filter((entry) => entry.status !== 'archived')) {
          gateResults.set(
            env.id,
            await this.gates.forEnvironment(projectId, id, env.id, facts, tx),
          );
        }
        const [builds, users] = await Promise.all([
          this.releases.buildsByIds(unique(deployments.map((row) => row.buildId)), tx),
          this.releases.usersByIds(unique(deployments.map((row) => row.actorId)), tx),
        ]);
        return {
          release,
          environments,
          deployments,
          build,
          runs,
          cases,
          defects,
          blocking,
          builds,
          users,
          gateResults,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const deploymentRef = (row: DevelopmentArtifact): PipelineDeploymentRef => {
      const built = data.builds.find((entry) => entry.id === row.buildId);
      const actor = data.users.find((entry) => entry.id === row.actorId);
      return {
        id: row.id,
        identifier: row.identifier,
        status: row.status as DeploymentStatus,
        trigger: row.trigger,
        isRollback: row.rollbackOfId !== null,
        build:
          row.buildId === null ? null : { id: row.buildId, identifier: built?.identifier ?? null },
        commitSha: row.commitSha,
        actor: actor === undefined ? null : { id: actor.id, fullName: actor.fullName },
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    };
    const of = (environment: Environment) => {
      const rows = data.deployments.filter((row) => row.environmentId === environment.id);
      return { rows, last: rows.find((row) => row.status !== 'cancelled') ?? null };
    };

    const stageEnvironments = data.environments.filter((env) => env.status !== 'archived');
    const perStage = stageEnvironments.map(of);
    const states = computePipelineStages({
      releaseStatus: data.release.status,
      hasBuild: data.build !== null,
      blockingDefects: data.blocking.length,
      stages: stageEnvironments.map((env, index) => {
        const last = perStage[index]?.last ?? null;
        return {
          environmentStatus: env.status as EnvironmentStatus,
          gatesBlocking: env.protected && gateBlocks(data.gateResults.get(env.id)),
          last:
            last === null
              ? null
              : {
                  status: last.status as DeploymentStatus,
                  isRollback: last.rollbackOfId !== null,
                },
        };
      }),
    });
    const canWrite = held.has('work_items.write');
    const canManage = held.has(PROTECTED_ENVIRONMENT_PERMISSION);
    const liveRuns = data.runs.filter((run) => run.status !== 'aborted');

    const stages: ReleasePipelineStage[] = stageEnvironments.map((env, index) => {
      const run = liveRuns.find(
        (entry) => entry.environment?.trim().toLowerCase() === env.name.toLowerCase(),
      );
      const counts = run === undefined ? null : statusCounts(run.counts);
      const last = perStage[index]?.last ?? null;
      return {
        ...states[index]!,
        environment: environmentRef(env),
        canDeploy:
          env.status === 'active' &&
          data.release.status !== 'archived' &&
          (env.protected ? canManage : canWrite),
        deploymentCount: perStage[index]!.rows.length,
        gates: gateSummary(data.gateResults.get(env.id)),
        lastDeployment: last === null ? null : deploymentRef(last),
        qa:
          run === undefined || counts === null
            ? null
            : {
                runId: run.id,
                name: run.name,
                status: run.status,
                result: computeQaResult(counts, run.status),
                counts,
              },
      };
    });

    const caseCounts = statusCounts(countStatuses(data.cases));
    const deployed = states.filter((state) => state.status === 'deployed').length;
    return {
      release: toReleaseView(data.release),
      status: computePipelineStatus(states),
      progress: {
        deployed,
        total: states.length,
        percent: states.length === 0 ? 0 : Math.round((deployed / states.length) * 100),
      },
      build: data.build,
      qa: { result: computeQaResult(caseCounts), counts: caseCounts },
      defects: { open: data.defects.open, blocking: data.blocking },
      stages: stages.filter(
        (stage) =>
          (query.environmentId === undefined || stage.environment.id === query.environmentId) &&
          (query.status === undefined || stage.status === query.status),
      ),
      history: data.environments
        .filter((env) => env.status === 'archived')
        .map((env) => ({ env, ...of(env) }))
        .filter((entry) => entry.rows.length > 0)
        .map((entry) => ({
          environment: environmentRef(entry.env),
          deploymentCount: entry.rows.length,
          lastDeployment: entry.last === null ? null : deploymentRef(entry.last),
        })),
      generatedAt: new Date().toISOString(),
    };
  }
}

function gateBlocks(gates: EnvironmentGates | undefined): boolean {
  return (
    gates !== undefined &&
    gates.override === null &&
    gates.required.result !== 'passed' &&
    gates.required.result !== 'not_applicable'
  );
}

function gateSummary(gates: EnvironmentGates | undefined): ReleasePipelineStage['gates'] {
  return {
    result: gates?.required.result ?? 'not_applicable',
    required: gates?.required.gateCount ?? 0,
    overridden: gates !== undefined && gates.override !== null,
  };
}

function unique(ids: ReadonlyArray<string | null>): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

function environmentRef(env: Environment): PipelineEnvironmentRef {
  return {
    id: env.id,
    name: env.name,
    kind: env.kind as EnvironmentKind,
    status: env.status as EnvironmentStatus,
    protected: env.protected,
    position: env.position,
  };
}

function countStatuses(
  rows: ReadonlyArray<{ status: TestResultStatus }>,
): Record<TestResultStatus, number> {
  const counts: Record<TestResultStatus, number> = {
    untested: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
  };
  for (const row of rows) {
    counts[row.status] += 1;
  }
  return counts;
}
