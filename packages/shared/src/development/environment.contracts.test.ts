import { describe, expect, it } from 'vitest';
import {
  computeEnvironmentHealth,
  createEnvironmentSchema,
  defaultProtected,
  updateEnvironmentSchema,
} from './environment.contracts.js';

describe('environment contracts', () => {
  it('derives health from status and the newest deployments', () => {
    expect(computeEnvironmentHealth('archived', 'failed', true)).toBe('archived');
    expect(computeEnvironmentHealth('inactive', null, false)).toBe('inactive');
    expect(computeEnvironmentHealth('active', null, false)).toBe('idle');
    expect(computeEnvironmentHealth('active', 'deploying', true)).toBe('deploying');
    expect(computeEnvironmentHealth('active', 'pending', false)).toBe('deploying');
    expect(computeEnvironmentHealth('active', 'failed', true)).toBe('failing');
    expect(computeEnvironmentHealth('active', 'succeeded', true)).toBe('healthy');
    expect(computeEnvironmentHealth('active', 'rolled_back', false)).toBe('idle');
  });

  it('protects production by default only', () => {
    expect(defaultProtected('production', undefined)).toBe(true);
    expect(defaultProtected('production', false)).toBe(false);
    expect(defaultProtected('staging', undefined)).toBe(false);
  });

  it('accepts plain metadata and refuses secrets, bad URLs and empty updates', () => {
    const base = { projectId: 'p', name: 'prod' };
    expect(createEnvironmentSchema.parse(base).kind).toBe('custom');
    expect(
      createEnvironmentSchema.safeParse({ ...base, metadata: { region: 'eu-west-1', replicas: 3 } })
        .success,
    ).toBe(true);
    for (const metadata of [
      { apiKey: 'x' },
      { db_password: 'x' },
      { note: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    ]) {
      expect(createEnvironmentSchema.safeParse({ ...base, metadata }).success).toBe(false);
    }
    expect(createEnvironmentSchema.safeParse({ ...base, url: 'ftp://x.example' }).success).toBe(
      false,
    );
    expect(updateEnvironmentSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateEnvironmentSchema.safeParse({ status: 'archived' }).success).toBe(false);
  });
});
