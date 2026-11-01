import { describe, expect, it } from 'vitest';
import {
  ALL_DEVELOPMENT_STATUSES,
  artifactReference,
  createDevelopmentArtifactSchema,
  listDevelopmentArtifactsQuerySchema,
  naturalKeyOf,
  statusesFor,
  updateDevelopmentArtifactSchema,
} from './development.contracts.js';

const base = { projectId: 'p' };
const ok = (body: object) =>
  createDevelopmentArtifactSchema.safeParse({ ...base, ...body }).success;

describe('development contracts', () => {
  it('requires the reference of each kind', () => {
    expect(ok({ kind: 'branch', branchName: 'feature/WEB-1-cards' })).toBe(true);
    expect(ok({ kind: 'branch' })).toBe(false);
    expect(ok({ kind: 'commit', commitSha: 'abc1234' })).toBe(true);
    expect(ok({ kind: 'commit', commitSha: 'xyz' })).toBe(false);
    expect(ok({ kind: 'pull_request', prNumber: 12 })).toBe(true);
    expect(ok({ kind: 'pull_request', prNumber: 0 })).toBe(false);
    expect(ok({ kind: 'build', identifier: 'build-7' })).toBe(true);
    expect(ok({ kind: 'deployment' })).toBe(false);
  });

  it('refuses bad branch names, unsafe URLs, statuses of another kind and stray environments', () => {
    expect(ok({ kind: 'branch', branchName: 'a..b' })).toBe(false);
    expect(ok({ kind: 'branch', branchName: '/main' })).toBe(false);
    expect(ok({ kind: 'build', identifier: 'b', url: 'javascript:alert(1)' })).toBe(false);
    expect(ok({ kind: 'build', identifier: 'b', url: 'https://ci.example.test/b' })).toBe(true);
    expect(ok({ kind: 'branch', branchName: 'main', status: 'open' })).toBe(false);
    expect(ok({ kind: 'commit', commitSha: 'abc1234', status: 'merged' })).toBe(false);
    expect(ok({ kind: 'build', identifier: 'b', environment: 'prod' })).toBe(false);
    expect(
      ok({ kind: 'deployment', identifier: 'd', environment: 'prod', status: 'rolled_back' }),
    ).toBe(true);
  });

  it('defaults to the local provider and normalises SHAs', () => {
    const parsed = createDevelopmentArtifactSchema.parse({
      ...base,
      kind: 'commit',
      commitSha: 'ABCDEF1234',
    });
    expect(parsed.provider).toBe('local');
    expect(parsed.commitSha).toBe('abcdef1234');
    expect(parsed.workItemIds).toEqual([]);
    expect(ok({ kind: 'commit', commitSha: 'abc1234', provider: 'jira' })).toBe(false);
  });

  it('derives natural keys and short references', () => {
    expect(naturalKeyOf({ kind: 'pull_request', prNumber: 7 })).toBe('#7');
    expect(naturalKeyOf({ kind: 'commit', commitSha: 'ABC1234' })).toBe('abc1234');
    expect(naturalKeyOf({ kind: 'deployment', identifier: 'deploy-3' })).toBe('deploy-3');
    expect(
      artifactReference({
        kind: 'commit',
        commitSha: 'abcdef1234567',
        branchName: null,
        prNumber: null,
        identifier: null,
      }),
    ).toBe('abcdef1');
    expect(statusesFor('commit')).toEqual([]);
    expect(ALL_DEVELOPMENT_STATUSES).toContain('rolled_back');
  });

  it('validates updates and list filters', () => {
    expect(updateDevelopmentArtifactSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(updateDevelopmentArtifactSchema.safeParse({ status: null }).success).toBe(true);
    expect(listDevelopmentArtifactsQuerySchema.parse({ projectId: 'p' })).toMatchObject({
      page: 1,
    });
    expect(
      listDevelopmentArtifactsQuerySchema.safeParse({ projectId: 'p', kind: 'issue' }).success,
    ).toBe(false);
  });
});
