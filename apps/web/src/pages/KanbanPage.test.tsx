import { describe, expect, it } from 'vitest';
import { columnCount } from './KanbanPage';

describe('columnCount', () => {
  it('shows the size of a column and its WIP limit when it has one', () => {
    expect(columnCount({ count: 3, wipLimit: null })).toBe('3');
    expect(columnCount({ count: 2, wipLimit: 3 })).toBe('2/3');
    expect(columnCount({ count: 4, wipLimit: 3 })).toBe('4/3');
  });
});
