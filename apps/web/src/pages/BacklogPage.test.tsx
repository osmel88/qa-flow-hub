import { describe, expect, it } from 'vitest';
import { dropMove } from './BacklogPage';

describe('dropMove', () => {
  const order = ['a', 'b', 'c', 'd'];

  it('drops a row below its target when dragged downwards', () => {
    expect(dropMove(order, 'a', 'c')).toEqual({ id: 'a', afterId: 'c' });
  });

  it('drops a row above its target when dragged upwards', () => {
    expect(dropMove(order, 'd', 'b')).toEqual({ id: 'd', beforeId: 'b' });
  });

  it('ignores a drop on itself or on an unknown row', () => {
    expect(dropMove(order, 'b', 'b')).toBeNull();
    expect(dropMove(order, 'x', 'b')).toBeNull();
    expect(dropMove(order, 'b', 'x')).toBeNull();
  });
});
