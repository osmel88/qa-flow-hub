import { describe, expect, it } from 'vitest';
import { dropPlacement } from './BoardPage';

describe('dropPlacement', () => {
  const column = ['a', 'b', 'c'];

  it('appends to the end of the column when dropped on the column itself', () => {
    expect(dropPlacement(column, 'x', null)).toEqual({ afterId: 'c' });
    expect(dropPlacement(column, 'c', null)).toEqual({ afterId: 'b' });
    expect(dropPlacement([], 'x', null)).toEqual({});
  });

  it('drops below the target when dragged downwards inside the column', () => {
    expect(dropPlacement(column, 'a', 'c')).toEqual({ afterId: 'c' });
  });

  it('drops above the target when dragged upwards or from another column', () => {
    expect(dropPlacement(column, 'c', 'a')).toEqual({ beforeId: 'a' });
    expect(dropPlacement(column, 'x', 'b')).toEqual({ beforeId: 'b' });
  });
});
