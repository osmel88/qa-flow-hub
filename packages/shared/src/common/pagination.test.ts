import { describe, expect, it } from 'vitest';
import {
  buildPaginationMeta,
  MAX_PAGE_SIZE,
  paginationQuerySchema,
  toSkipTake,
} from './pagination.js';

describe('paginationQuerySchema', () => {
  it('applies defaults when the query is empty', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
  });

  it('coerces string query parameters, because HTTP has no numbers', () => {
    expect(paginationQuerySchema.parse({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
  });

  it('rejects a page size above the hard limit', () => {
    expect(() => paginationQuerySchema.parse({ pageSize: MAX_PAGE_SIZE + 1 })).toThrow();
  });
});

describe('buildPaginationMeta', () => {
  it('reports zero pages for an empty result set', () => {
    expect(buildPaginationMeta({ page: 1, pageSize: 20 }, 0).totalPages).toBe(0);
  });

  it('rounds the last partial page up', () => {
    expect(buildPaginationMeta({ page: 1, pageSize: 20 }, 21).totalPages).toBe(2);
  });
});

describe('toSkipTake', () => {
  it('translates a 1-based page into a 0-based offset', () => {
    expect(toSkipTake({ page: 3, pageSize: 20 })).toEqual({ skip: 40, take: 20 });
  });
});
