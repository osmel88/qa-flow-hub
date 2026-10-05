import { describe, expect, it } from 'vitest';
import { databaseRoleProblems } from './database-role.inspector';

const runtime = { role: 'qaflow_app', superuser: false, bypassRls: false, ownsTables: false };

describe('databaseRoleProblems', () => {
  it('accepts the non-owning runtime role', () => {
    expect(databaseRoleProblems(runtime)).toEqual([]);
  });

  it.each([
    ['the table owner', { ownsTables: true }, 'owns application tables'],
    ['a superuser', { superuser: true }, 'is a superuser'],
    ['a BYPASSRLS role', { bypassRls: true }, 'has BYPASSRLS'],
  ])('flags %s, because the policies do not apply to it', (_label, change, problem) => {
    expect(databaseRoleProblems({ ...runtime, ...change })).toEqual([problem]);
  });
});
