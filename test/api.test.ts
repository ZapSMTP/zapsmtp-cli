import { describe, expect, it } from 'vitest';
import { nextPageQuery, snake } from '../src/generated/model.js';

describe('paging', () => {
  it('continues every kind of list as the SDK does', () => {
    const page = (data: any[], extra = {}) => ({ data, has_more: true, ...extra });
    const items = [{ id: 'a', last_message_at: 't1' }, { id: 'b', last_message_at: 't2' }];
    expect(nextPageQuery('before', { limit: 2 }, page(items))).toEqual({ limit: 2, before: 'b' });
    expect(nextPageQuery('after', {}, page(items))).toEqual({ after: 'b' });
    expect(nextPageQuery('logs', {}, page(items))).toEqual({ before: 'b' });
    expect(nextPageQuery('logs', { after: 'z' }, page(items))).toEqual({ after: 'a' });
    expect(nextPageQuery('thread', {}, page(items))).toEqual({ before: 't2', before_id: 'b' });
    expect(nextPageQuery('cursor', {}, page(items, { next_cursor: 'nc' }))).toEqual({ after: 'nc' });
    expect(nextPageQuery('cursor', {}, page(items))).toBeNull();
    expect(nextPageQuery(null, {}, page(items))).toBeNull();
    expect(nextPageQuery('before', {}, { data: items, has_more: false })).toBeNull();
    for (const p of ['before', 'after', 'thread'] as const) expect(nextPageQuery(p, {}, page([]))).toBeNull();
    expect(nextPageQuery('logs', {}, page([]))).toBeNull();
    expect(nextPageQuery('logs', { after: 'z' }, page([]))).toBeNull();
    expect(snake('forwardDestinations')).toBe('forward_destinations');
  });
});
