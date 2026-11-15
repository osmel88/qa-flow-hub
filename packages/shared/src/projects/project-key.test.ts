import { describe, expect, it } from 'vitest';
import { PROJECT_KEY_RULE, createProjectSchema, projectKeySchema } from './project.contracts.js';

describe('projectKeySchema', () => {
  it.each(['QA', 'WEB', 'WEB2', 'QA01', 'ABCDEFGH'])('accepts %s', (key) => {
    expect(projectKeySchema.safeParse(key).success).toBe(true);
  });

  it.each(['1QA', 'Q', 'WEB-2', 'WEB_2', 'ABCDEFGHI', 'W EB', 'QA!', 'Q@A', ''])(
    'rejects %j with the shared rule',
    (key) => {
      const result = projectKeySchema.safeParse(key);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(PROJECT_KEY_RULE);
    },
  );

  it('is the rule the create schema applies', () => {
    expect(createProjectSchema.safeParse({ name: 'Web', key: 'WEB-2' }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: 'Web', key: 'WEB2' }).success).toBe(true);
  });
});
