import { describe, expect, it } from 'vitest';
import {
  computePipelineStages,
  computePipelineStatus,
  computeQaResult,
} from './release-pipeline.contracts.js';
import type { PipelineStageInput } from './release-pipeline.contracts.js';

const active = (last: PipelineStageInput['last'] = null): PipelineStageInput => ({
  environmentStatus: 'active',
  last,
});
const run = (status: 'succeeded' | 'failed' | 'deploying' | 'pending' | 'rolled_back') => ({
  status,
  isRollback: false,
});
const statuses = (input: Parameters<typeof computePipelineStages>[0]) =>
  computePipelineStages(input).map((state) => state.status);

describe('release pipeline rules', () => {
  const base = { releaseStatus: 'in_progress' as const, hasBuild: true, blockingDefects: 0 };

  it('is ready stage by stage once a build exists, and pending without one', () => {
    expect(statuses({ ...base, stages: [active(), active()] })).toEqual(['ready', 'pending']);
    expect(statuses({ ...base, hasBuild: false, stages: [active(), active()] })).toEqual([
      'pending',
      'pending',
    ]);
    expect(statuses({ ...base, stages: [active(run('succeeded')), active()] })).toEqual([
      'deployed',
      'ready',
    ]);
    expect(computePipelineStatus(computePipelineStages({ ...base, stages: [] }))).toBe(
      'not_started',
    );
  });

  it('shows deploying, failed and what a failure blocks', () => {
    const states = computePipelineStages({
      ...base,
      stages: [active(run('succeeded')), active(run('failed')), active()],
    });
    expect(states.map((state) => state.status)).toEqual(['deployed', 'failed', 'blocked']);
    expect(states[2]!.blockers).toEqual(['previous_stage_failed']);
    expect(computePipelineStatus(states)).toBe('failed');
    const moving = computePipelineStages({ ...base, stages: [active(run('pending')), active()] });
    expect(moving.map((state) => state.status)).toEqual(['deploying', 'pending']);
    expect(computePipelineStatus(moving)).toBe('deploying');
  });

  it('treats a rollback as not deployed and keeps deployed stages deployed under blockers', () => {
    const rolled = computePipelineStages({
      ...base,
      stages: [active(run('succeeded')), active({ status: 'succeeded', isRollback: true })],
    });
    expect(rolled.map((state) => [state.status, state.rolledBack])).toEqual([
      ['deployed', false],
      ['ready', true],
    ]);
    expect(computePipelineStatus(rolled)).toBe('in_progress');
    const blocked = computePipelineStages({
      ...base,
      blockingDefects: 2,
      stages: [active(run('succeeded')), { environmentStatus: 'inactive', last: null }],
    });
    expect(blocked.map((state) => state.status)).toEqual(['deployed', 'blocked']);
    expect(blocked[1]!.blockers).toEqual(['environment_inactive', 'blocking_defects']);
    expect(computePipelineStatus(blocked)).toBe('blocked');
    expect(
      computePipelineStatus(computePipelineStages({ ...base, stages: [active(run('succeeded'))] })),
    ).toBe('completed');
  });

  it('derives the QA result', () => {
    const counts = { failed: 0, blocked: 0, passed: 0, executed: 0, total: 0 };
    expect(computeQaResult(counts)).toBe('none');
    expect(computeQaResult(counts, 'in_progress')).toBe('in_progress');
    expect(computeQaResult({ ...counts, passed: 2, executed: 2, total: 2 })).toBe('passed');
    expect(computeQaResult({ ...counts, passed: 1, executed: 1, total: 2 })).toBe('in_progress');
    expect(computeQaResult({ ...counts, failed: 1, blocked: 1, executed: 2, total: 2 })).toBe(
      'failed',
    );
    expect(computeQaResult({ ...counts, blocked: 1, executed: 1, total: 1 })).toBe('blocked');
  });
});
