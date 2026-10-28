import { describe, expect, it } from 'vitest';
import { fakeFetch, KEY, run } from './helpers.js';

const env = { ZAP_API_KEY: KEY };

describe('independent CLI argument regressions', () => {
  it.each([
    { argv: ['emails', 'list', '--unknown=value'] },
    { argv: ['whoami', '--unknown=value'] },
    { argv: ['emails', 'list', '--no-limit'] },
  ])('reports invalid flags as usage errors: $argv', async ({ argv }) => {
    const f = fakeFetch(() => [200, { plan: { name: 'Free' } }]);
    const r = await run(argv, { env, fetch: f.fetch });
    expect({ code: r.code, requests: f.requests.length }).toEqual({ code: 2, requests: 0 });
  });

  it('retains JSON input when a later bare --json requests JSON output', async () => {
    const f = fakeFetch(() => [200, { id: 'sent' }]);
    const r = await run(['send', '--json', '{"from":"a@example.test","to":"b@example.test","text":"hello"}', '--json'], { env, fetch: f.fetch });
    expect(r.code, r.err).toBe(0);
    expect(f.requests[0].body).toEqual({ from: 'a@example.test', to: 'b@example.test', text: 'hello' });
    expect(r.json()).toEqual({ id: 'sent' });
  });

  it('flags override a JSON recipient list instead of retaining its recipients', async () => {
    const f = fakeFetch(() => [200, { id: 'sent' }]);
    const r = await run(['send', '--json', '{"from":"a@example.test","to":["old@example.test"]}', '--to', 'new@example.test', '--to', 'second@example.test'], { env, fetch: f.fetch });
    expect(r.code, r.err).toBe(0);
    expect(f.requests[0].body.to).toEqual(['new@example.test', 'second@example.test']);
  });

  it('rejects overflowing integer flags as malformed values', async () => {
    const f = fakeFetch(() => [200, { data: [], has_more: false }]);
    const r = await run(['emails', 'list', '--limit', '9'.repeat(400)], { env, fetch: f.fetch });
    expect({ code: r.code, requests: f.requests.length }).toEqual({ code: 2, requests: 0 });
  });
});
