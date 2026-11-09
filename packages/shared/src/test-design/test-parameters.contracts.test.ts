import { describe, expect, it } from 'vitest';
import {
  parseParameterCell,
  replaceParametersSchema,
  resolveRowValues,
  validateParameterDefinition,
} from './test-parameters.contracts.js';

const PARAMETERS = [
  { name: 'user', type: 'string' as const, required: true },
  { name: 'amount', type: 'number' as const, required: false, defaultValue: 10 },
  { name: 'vip', type: 'boolean' as const, required: false },
  { name: 'day', type: 'date' as const, required: false },
];

describe('parameterized test cases', () => {
  it('accepts a valid dataset and resolves defaults', () => {
    const rows = [{ values: { user: 'ann', vip: true, day: '2027-02-28' } }];
    expect(validateParameterDefinition(PARAMETERS, rows)).toEqual([]);
    expect(
      resolveRowValues(
        PARAMETERS.map((p) => ({ ...p, defaultValue: p.defaultValue ?? null })),
        rows[0]!,
      ),
    ).toEqual({
      user: 'ann',
      amount: 10,
      vip: true,
      day: '2027-02-28',
    });
  });

  it('reports wrong types, missing values, unknown columns and duplicates', () => {
    const errors = validateParameterDefinition(
      [...PARAMETERS, { name: 'USER', type: 'string', required: false }],
      [
        { values: { amount: 'x', vip: 'no', day: '2027-02-30', ghost: 1 } },
        { id: 'a', values: { user: 'b' } },
        { id: 'a', values: { user: 'c' } },
      ],
    );
    expect(errors).toEqual([
      'Parameter USER is defined twice',
      'Row 1: amount expects a number',
      'Row 1: vip expects true or false',
      'Row 1: day expects a YYYY-MM-DD date',
      'Row 1: unknown parameter ghost',
      'Row 1: user is required',
      'Row 3: duplicate row id a',
    ]);
    expect(validateParameterDefinition([], [{ values: {} }])).toEqual([
      'A dataset needs at least one parameter',
    ]);
  });

  it('parses CSV cells by type', () => {
    expect(parseParameterCell('number', ' 4.5 ')).toEqual({ value: 4.5 });
    expect(parseParameterCell('number', 'four')).toEqual({ error: 'expects a number' });
    expect(parseParameterCell('boolean', 'Yes')).toEqual({ value: true });
    expect(parseParameterCell('boolean', '0')).toEqual({ value: false });
    expect(parseParameterCell('date', '2027-13-01')).toHaveProperty('error');
    expect(parseParameterCell('string', '')).toEqual({ value: null });
  });

  it('validates the replace body as a whole', () => {
    expect(replaceParametersSchema.safeParse({ parameters: PARAMETERS, rows: [] }).success).toBe(
      true,
    );
    expect(
      replaceParametersSchema.safeParse({ parameters: [{ name: '_id', type: 'string' }], rows: [] })
        .success,
    ).toBe(false);
    expect(
      replaceParametersSchema.safeParse({ parameters: PARAMETERS, rows: [{ values: {} }] }).success,
    ).toBe(false);
  });
});
