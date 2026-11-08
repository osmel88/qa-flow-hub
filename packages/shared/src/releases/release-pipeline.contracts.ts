import { z } from 'zod';
import type { DeploymentStatus } from '../development/deployment.contracts.js';
import type { EnvironmentKind, EnvironmentStatus } from '../development/environment.contracts.js';
import type { ReleaseStatus, ReleaseStatusCounts, ReleaseView } from './release.contracts.js';

/**
 * Release pipeline (S6-F2): the stages a release goes through, one per
 * active or inactive environment in environment order. Everything here is
 * derived on read from releases, builds, environments, deployments, test
 * runs and defects; nothing is stored. Archived environments keep their
 * history but are not stages.
 */
export const PIPELINE_STAGE_STATUSES = [
  'pending',
  'ready',
  'deploying',
  'deployed',
  'failed',
  'blocked',
] as const;
export type PipelineStageStatus = (typeof PIPELINE_STAGE_STATUSES)[number];

export const PIPELINE_STATUSES = [
  'not_started',
  'in_progress',
  'deploying',
  'failed',
  'blocked',
  'completed',
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export const PIPELINE_BLOCKERS = [
  'release_archived',
  'environment_inactive',
  'blocking_defects',
  'previous_stage_failed',
] as const;
export type PipelineBlocker = (typeof PIPELINE_BLOCKERS)[number];

export const QA_RESULTS = ['none', 'in_progress', 'passed', 'failed', 'blocked'] as const;
export type QaResult = (typeof QA_RESULTS)[number];

/** Defects that block the stages a release has not reached yet. */
export const BLOCKING_DEFECT_SEVERITIES = ['blocker', 'critical'] as const;

export const releasePipelineQuerySchema = z.object({
  environmentId: z.string().min(1).max(64).optional(),
  status: z.enum(PIPELINE_STAGE_STATUSES).optional(),
});
export type ReleasePipelineQuery = z.infer<typeof releasePipelineQuerySchema>;

export interface PipelineStageInput {
  environmentStatus: EnvironmentStatus;
  /** Newest non-cancelled deployment of the release there, if any. */
  last: { status: DeploymentStatus; isRollback: boolean } | null;
}

export interface PipelineStageState {
  status: PipelineStageStatus;
  blockers: PipelineBlocker[];
  /** The release ran there and was rolled back since. */
  rolledBack: boolean;
}

/**
 * Stage rules, in order: a live deployment decides (in flight → deploying,
 * failed → failed, succeeded → deployed); a rolled back release counts as
 * not deployed. Otherwise known blockers make it `blocked`; it is `ready`
 * with a passed build of the release and the previous stage deployed (the
 * first stage only needs the build), and `pending` if not.
 */
export function computePipelineStages(input: {
  releaseStatus: ReleaseStatus;
  hasBuild: boolean;
  blockingDefects: number;
  stages: readonly PipelineStageInput[];
}): PipelineStageState[] {
  const states: PipelineStageState[] = [];
  for (const [index, stage] of input.stages.entries()) {
    const previous = index === 0 ? null : states[index - 1]!;
    const rolledBack =
      stage.last !== null && (stage.last.isRollback || stage.last.status === 'rolled_back');
    if (stage.last !== null && !rolledBack) {
      const status: PipelineStageStatus =
        stage.last.status === 'succeeded'
          ? 'deployed'
          : stage.last.status === 'failed'
            ? 'failed'
            : 'deploying';
      states.push({ status, blockers: [], rolledBack: false });
      continue;
    }
    const blockers: PipelineBlocker[] = [];
    if (input.releaseStatus === 'archived') {
      blockers.push('release_archived');
    }
    if (stage.environmentStatus !== 'active') {
      blockers.push('environment_inactive');
    }
    if (input.blockingDefects > 0) {
      blockers.push('blocking_defects');
    }
    if (previous?.status === 'failed') {
      blockers.push('previous_stage_failed');
    }
    const status: PipelineStageStatus =
      blockers.length > 0
        ? 'blocked'
        : input.hasBuild && (previous === null || previous.status === 'deployed')
          ? 'ready'
          : 'pending';
    states.push({ status, blockers, rolledBack });
  }
  return states;
}

/** Pipeline status: failed > deploying > completed > blocked > in progress > not started. */
export function computePipelineStatus(states: readonly PipelineStageState[]): PipelineStatus {
  if (states.length === 0) {
    return 'not_started';
  }
  if (states.some((state) => state.status === 'failed')) {
    return 'failed';
  }
  if (states.some((state) => state.status === 'deploying')) {
    return 'deploying';
  }
  if (states.every((state) => state.status === 'deployed')) {
    return 'completed';
  }
  if (states.some((state) => state.status === 'blocked')) {
    return 'blocked';
  }
  return states.some((state) => state.status === 'deployed' || state.rolledBack)
    ? 'in_progress'
    : 'not_started';
}

/** QA outcome of counted cases: failures, then blocks, then all executed passing. */
export function computeQaResult(
  counts: Pick<ReleaseStatusCounts, 'failed' | 'blocked' | 'passed' | 'executed' | 'total'>,
  runStatus?: string,
): QaResult {
  if (counts.failed > 0) {
    return 'failed';
  }
  if (counts.blocked > 0) {
    return 'blocked';
  }
  if (counts.total > 0 && counts.executed === counts.total && counts.passed > 0) {
    return 'passed';
  }
  if (counts.executed > 0 || runStatus === 'in_progress') {
    return 'in_progress';
  }
  return 'none';
}

export interface PipelineEnvironmentRef {
  id: string;
  name: string;
  kind: EnvironmentKind;
  status: EnvironmentStatus;
  protected: boolean;
  position: number;
}

export interface PipelineDeploymentRef {
  id: string;
  identifier: string | null;
  status: DeploymentStatus;
  trigger: string | null;
  isRollback: boolean;
  build: { id: string; identifier: string | null } | null;
  commitSha: string | null;
  actor: { id: string; fullName: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface ReleasePipelineStage extends PipelineStageState {
  environment: PipelineEnvironmentRef;
  /** The current user may deploy there (`work_items.manage` when protected). */
  canDeploy: boolean;
  deploymentCount: number;
  lastDeployment: PipelineDeploymentRef | null;
  /** Newest non-aborted run of the release whose environment matches by name. */
  qa: {
    runId: string;
    name: string;
    status: string;
    result: QaResult;
    counts: ReleaseStatusCounts;
  } | null;
}

export interface ReleasePipelineView {
  release: ReleaseView;
  status: PipelineStatus;
  /** Over every stage, whatever the filters. */
  progress: { deployed: number; total: number; percent: number };
  /** Newest passed build of the release: what the next stage would ship. */
  build: { id: string; identifier: string | null; commitSha: string | null } | null;
  qa: { result: QaResult; counts: ReleaseStatusCounts };
  defects: {
    open: number;
    blocking: Array<{ id: string; key: string; title: string; severity: string; status: string }>;
  };
  stages: ReleasePipelineStage[];
  /** Archived environments where the release ran: history, not stages. */
  history: Array<{
    environment: PipelineEnvironmentRef;
    deploymentCount: number;
    lastDeployment: PipelineDeploymentRef | null;
  }>;
  generatedAt: string;
}
