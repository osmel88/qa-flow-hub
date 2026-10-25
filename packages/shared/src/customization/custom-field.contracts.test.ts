import { describe, expect, it } from 'vitest';
import {
  checkCustomFieldValue,
  createCustomFieldSchema,
  customFieldValuesInputSchema,
  parseCustomFieldFilter,
  updateCustomFieldSchema,
} from './custom-field.contracts.js';
import {
  DEFAULT_DEFECT_TRANSITIONS,
  updateDefectWorkflowSchema,
  workflowProblems,
} from './defect-workflow.contracts.js';

const options = [
  { id: 'opt_a', label: 'Chrome', archived: false },
  { id: 'opt_b', label: 'Safari', archived: true },
];

describe('custom field definitions', () => {
  it('accepts a select field with options and rejects keys that are not snake case', () => {
    expect(
      createCustomFieldSchema.safeParse({
        projectId: 'p',
        entityType: 'defect',
        key: 'browser',
        label: 'Browser',
        type: 'select',
        options: [{ label: 'Chrome' }],
      }).success,
    ).toBe(true);
    for (const key of ['Browser', '1browser', 'bro-wser', '', 'a'.repeat(41)]) {
      expect(
        createCustomFieldSchema.safeParse({
          projectId: 'p',
          entityType: 'defect',
          key,
          label: 'Browser',
          type: 'text',
        }).success,
      ).toBe(false);
    }
  });

  it('requires options for select types only, without duplicates', () => {
    const base = { projectId: 'p', entityType: 'defect', key: 'k', label: 'K' };
    expect(createCustomFieldSchema.safeParse({ ...base, type: 'select' }).success).toBe(false);
    expect(
      createCustomFieldSchema.safeParse({ ...base, type: 'text', options: [{ label: 'x' }] })
        .success,
    ).toBe(false);
    expect(
      createCustomFieldSchema.safeParse({
        ...base,
        type: 'multi_select',
        options: [{ label: 'Chrome' }, { label: 'chrome' }],
      }).success,
    ).toBe(false);
  });

  it('refuses an empty update and does not accept type or key changes', () => {
    expect(updateCustomFieldSchema.safeParse({}).success).toBe(false);
    const parsed = updateCustomFieldSchema.parse({ label: 'New', type: 'number', key: 'x' });
    expect(parsed).toEqual({ label: 'New' });
  });
});

describe('checkCustomFieldValue', () => {
  it('normalises text, numbers, booleans and dates', () => {
    expect(checkCustomFieldValue({ type: 'text', options: [] }, '  hi ')).toEqual({
      ok: true,
      value: 'hi',
    });
    expect(checkCustomFieldValue({ type: 'text', options: [] }, '   ')).toEqual({
      ok: true,
      value: null,
    });
    expect(checkCustomFieldValue({ type: 'number', options: [] }, 3.5).ok).toBe(true);
    expect(checkCustomFieldValue({ type: 'number', options: [] }, '3').ok).toBe(false);
    expect(checkCustomFieldValue({ type: 'number', options: [] }, Number.NaN).ok).toBe(false);
    expect(checkCustomFieldValue({ type: 'number', options: [] }, 1e13).ok).toBe(false);
    expect(checkCustomFieldValue({ type: 'boolean', options: [] }, 'true').ok).toBe(false);
    expect(checkCustomFieldValue({ type: 'date', options: [] }, '2026-02-28').ok).toBe(true);
    expect(checkCustomFieldValue({ type: 'date', options: [] }, '2026-02-30').ok).toBe(false);
    expect(checkCustomFieldValue({ type: 'date', options: [] }, '2026-2-1').ok).toBe(false);
  });

  it('only offers active options, but keeps an archived one already chosen', () => {
    const select = { type: 'select' as const, options };
    expect(checkCustomFieldValue(select, 'opt_a').ok).toBe(true);
    expect(checkCustomFieldValue(select, 'opt_b').ok).toBe(false);
    expect(checkCustomFieldValue(select, 'opt_b', 'opt_b').ok).toBe(true);
    expect(checkCustomFieldValue(select, 'Chrome').ok).toBe(false);
  });

  it('deduplicates multi-select values and clears an empty list', () => {
    const multi = { type: 'multi_select' as const, options };
    expect(checkCustomFieldValue(multi, ['opt_a', 'opt_a'])).toEqual({
      ok: true,
      value: ['opt_a'],
    });
    expect(checkCustomFieldValue(multi, [])).toEqual({ ok: true, value: null });
    expect(checkCustomFieldValue(multi, ['opt_b']).ok).toBe(false);
    expect(checkCustomFieldValue(multi, ['opt_a', 'opt_b'], ['opt_b']).ok).toBe(true);
    expect(checkCustomFieldValue(multi, 'opt_a').ok).toBe(false);
  });

  it('bounds the shape of a write', () => {
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, 'x']));
    expect(customFieldValuesInputSchema.safeParse(many).success).toBe(false);
    expect(customFieldValuesInputSchema.safeParse({ f: { nested: true } }).success).toBe(false);
    expect(customFieldValuesInputSchema.safeParse({ f: null }).success).toBe(true);
  });

  it('parses filters per type', () => {
    expect(parseCustomFieldFilter('number', '4')).toBe(4);
    expect(parseCustomFieldFilter('number', 'four')).toBeNull();
    expect(parseCustomFieldFilter('number', ' ')).toBeNull();
    expect(parseCustomFieldFilter('boolean', 'false')).toBe(false);
    expect(parseCustomFieldFilter('boolean', 'no')).toBeNull();
    expect(parseCustomFieldFilter('select', 'opt_a')).toBe('opt_a');
  });
});

describe('defect workflow', () => {
  it('accepts the built-in graph', () => {
    expect(workflowProblems(DEFAULT_DEFECT_TRANSITIONS)).toEqual([]);
    expect(DEFAULT_DEFECT_TRANSITIONS).toHaveLength(16);
  });

  it('rejects self loops, duplicates and statuses that can never close', () => {
    const t = (from: string, to: string) =>
      ({ from, to, permission: 'defects.create', requiredFieldIds: [] }) as never;
    expect(workflowProblems([t('open', 'open')])).toContain(
      'open->open does not change the status',
    );
    expect(workflowProblems([t('open', 'closed'), t('open', 'closed')])).toContain(
      'open->closed is listed twice',
    );
    const trapped = workflowProblems([t('open', 'closed')]);
    expect(trapped).toContain('A defect in triaged could never be closed or rejected');
    expect(trapped).not.toContain('A defect in open could never be closed or rejected');
  });

  it('validates the update payload with the same rules', () => {
    expect(
      updateDefectWorkflowSchema.safeParse({
        projectId: 'p',
        version: 0,
        transitions: [{ from: 'open', to: 'closed' }],
      }).success,
    ).toBe(false);
    expect(
      updateDefectWorkflowSchema.safeParse({
        projectId: 'p',
        version: 0,
        transitions: DEFAULT_DEFECT_TRANSITIONS,
      }).success,
    ).toBe(true);
  });
});
