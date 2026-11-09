import { describe, expect, it } from 'vitest';
import {
  TestCaseVersionContent,
  diffVersionContent,
  restoreVersionSchema,
  versionDiffQuerySchema,
} from './test-case-version.contracts.js';

const BASE: TestCaseVersionContent = {
  title: 'Pay with a card',
  description: null,
  preconditions: 'Logged in',
  expectedResult: null,
  type: 'functional',
  priority: 'medium',
  steps: [
    { position: 1, action: 'Open cart', expectedResult: null, data: null },
    { position: 2, action: 'Pay', expectedResult: 'Receipt', data: null },
  ],
  parameters: [
    { name: 'user', type: 'string', required: true, defaultValue: null, description: null },
  ],
  dataset: [{ id: 'r1', label: 'Row 1', values: { user: 'ann' } }],
};

describe('test case versions', () => {
  it('reports identical content as identical', () => {
    expect(diffVersionContent(BASE, structuredClone(BASE))).toMatchObject({
      identical: true,
      fields: [],
      steps: [],
      parameters: [],
    });
  });

  it('diffs fields, steps, parameters and dataset', () => {
    const next: TestCaseVersionContent = {
      ...BASE,
      title: 'Pay with a saved card',
      priority: 'high',
      steps: [
        { position: 1, action: 'Open cart', expectedResult: null, data: null },
        { position: 2, action: 'Pay now', expectedResult: 'Receipt', data: null },
        { position: 3, action: 'Logout', expectedResult: null, data: null },
      ],
      parameters: [
        { name: 'user', type: 'string', required: false, defaultValue: null, description: null },
        { name: 'amount', type: 'number', required: false, defaultValue: 5, description: null },
      ],
      dataset: [],
    };
    const diff = diffVersionContent(BASE, next);
    expect(diff.identical).toBe(false);
    expect(diff.fields.map((change) => change.field)).toEqual(['title', 'priority']);
    expect(diff.steps.map((change) => [change.position, change.change])).toEqual([
      [2, 'changed'],
      [3, 'added'],
    ]);
    expect(diff.parameters.map((change) => [change.name, change.change])).toEqual([
      ['user', 'changed'],
      ['amount', 'added'],
    ]);
    expect(diff.dataset).toEqual({ before: 1, after: 0, changed: true });
    expect(diffVersionContent(next, BASE).steps.at(-1)?.change).toBe('removed');
  });

  it('validates restore bodies and diff queries', () => {
    expect(restoreVersionSchema.safeParse({ version: 2, reason: 'Back to v1' }).success).toBe(true);
    expect(restoreVersionSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(restoreVersionSchema.safeParse({ reason: ' ' }).success).toBe(false);
    expect(versionDiffQuerySchema.parse({ from: '1', to: '3' })).toEqual({ from: 1, to: 3 });
    expect(versionDiffQuerySchema.safeParse({ from: 'x', to: '1' }).success).toBe(false);
  });
});
