import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { leadingWords, parse, UsageError } from '../src/args.js';
import { commands, flagSpecs, kebab, placeholder } from '../src/commands.js';
import { configPath, readConfig, writeConfig } from '../src/config.js';
import { commandHelp, groupHelp, wrapText } from '../src/help.js';
import { cell, details, style, table } from '../src/output.js';
import { GLOBAL_FLAGS } from '../src/args.js';
import { API } from '../src/generated/api.js';
import { fakeFetch, run, tmp, vectors } from './helpers.js';

const plain = style(false);
const page = (data: unknown[], has_more = false, extra = {}) => ({ object: 'list', has_more, data, ...extra });
const KEYENV = { ZAP_API_KEY: 'zap_test_k', ZAP_BASE_URL: 'http://api.test/v1' };

describe('commands from the API model', () => {
  it('has a command with working help for every operation', async () => {
    for (const c of commands()) {
      const r = await run([...c.words, '--help']);
      expect(r.code, c.words.join(' ')).toBe(0);
      expect(r.out).toContain(`zapsmtp ${c.words.join(' ')}`);
      expect(r.out).toContain(c.op.title);
      for (const p of [...c.op.query, ...c.op.body]) expect(r.out, `${c.op.id} ${p.name}`).toContain(`--${kebab(p.name)}`);
      for (const p of c.op.pathParams) expect(r.out).toContain(`<${kebab(p.name)}>`);
    }
  });

  it('never lets a parameter shadow a global flag', () => {
    for (const c of commands()) for (const name of flagSpecs(c.op).keys()) expect(GLOBAL_FLAGS, `${c.op.id} --${name}`).not.toHaveProperty(name);
  });

  it('names commands in kebab-case after the SDK', () => {
    const words = commands().map((c) => c.words.join(' '));
    expect(words).toContain('emails receiving list');
    expect(words).toContain('templates versions get');
    expect(words).toContain('inbound forward-destinations resend-confirmation');
    expect(words).toContain('emails send-batch');
    expect(kebab('reply_to')).toBe('reply-to');
  });

  it('gives each parameter type its flag syntax', () => {
    const send = flagSpecs(API.operations.find((o) => o.id === 'send-email')!);
    const kinds = Object.fromEntries([...send].map(([n, s]) => [n, s.kind]));
    expect(kinds).toMatchObject({
      to: 'list', subject: 'value', 'html-file': 'file', headers: 'map', header: 'map', tags: 'pairs', tag: 'pairs',
      attachments: 'objects', attach: 'attach', tracking: 'object', metadata: 'map', 'reply-to': 'list', reply_to: 'list',
    });
    expect(send.get('reply_to')!.primary).toBe(false);
    const tpl = flagSpecs(API.operations.find((o) => o.id === 'create-template')!);
    expect(tpl.get('design')!.kind).toBe('json');
    expect(tpl.get('publish')!.kind).toBe('bool');
    expect(tpl.get('variable-schema')!.kind).toBe('objects');
    const batch = flagSpecs(API.operations.find((o) => o.id === 'add-suppressions')!);
    expect(batch.get('email')!.kind).toBe('list');
    const ph = (op: string, f: string) => placeholder(flagSpecs(API.operations.find((o) => o.id === op)!).get(f)!);
    expect([ph('send-email', 'to'), ph('send-email', 'tag'), ph('send-email', 'metadata'), ph('send-email', 'attach'), ph('send-email', 'tracking'),
      ph('list-emails', 'limit'), ph('list-emails', 'status').startsWith(' <queued|'), ph('create-template', 'publish'), ph('send-email', 'subject'), ph('add-suppressions', 'emails')])
      .toEqual([' <address>', ' <name=value>', ' <key=value>', ' <path>', ' <json>', ' <n>', true, '', ' <value>', ' <value>']);
  });
});

describe('arguments', () => {
  it('finds the command words around global flags', () => {
    expect(leadingWords(['--profile', 'w', 'emails', 'get', 'id1', '--json'])).toEqual(['emails', 'get', 'id1']);
    expect(leadingWords(['emails', 'send', '--to', 'x'])).toEqual(['emails', 'send']);
    expect(leadingWords(['--json', '{"a":1}', 'emails', '-h', 'list', '--', 'x'])).toEqual(['emails', 'list']);
    expect(leadingWords(['--key=k', '-', 'x'])).toEqual(['-', 'x']);
  });

  it('splits flags and values', () => {
    const p = parse(['a', '--x', '1', '--y=2', '--b', '-h', '-5', '--json', '--json', '[1]', '--', '--z'], (n) => n !== 'b');
    expect(p).toEqual({ positionals: ['a', '-5', '--z'], flags: [
      { name: 'x', value: '1' }, { name: 'y', value: '2' }, { name: 'b', value: undefined }, { name: 'help', value: undefined },
      { name: 'json', value: undefined }, { name: 'json', value: '[1]' }] });
    expect(() => parse(['-x'], () => true)).toThrow('Unknown flag -x');
    expect(() => parse(['--=1'], () => true)).toThrow('Bad flag --=1');
    expect(() => parse(['--x'], () => true)).toThrow('--x needs a value');
    expect(() => parse(['--x', '--y'], () => true)).toThrow('--x needs a value');
    expect(new UsageError('m').command).toEqual([]);
  });
});

describe('output', () => {
  it('formats cells', () => {
    expect([cell(null), cell(undefined), cell(['a', 1, null]), cell({ a: 1 }), cell([{ a: 1 }]), cell('x\n y'), cell(true)])
      .toEqual(['', '', 'a, 1, ', '{"a":1}', '[{"a":1}]', 'x y', 'true']);
  });

  it('fits tables to the width and picks the useful columns', () => {
    const rows = [{ created_at: '2026-10-21T15:04:10Z', id: 'e1', subject: 'A very long subject line that goes on and on', zz: 1, nested: { a: 1 }, to: ['a@x.com'] }];
    const t = table(rows, 60, plain);
    expect(t.split('\n')[0]).toMatch(/^ID +TO +SUBJECT +CREATED_AT +ZZ$/);
    for (const line of t.trimEnd().split('\n')) expect(line.length).toBeLessThanOrEqual(60);
    expect(t).toContain('…');
    expect(table([], 80, plain)).toBe('(none)\n');
    const many = table([{ a1: 'x'.repeat(30), a2: 'y'.repeat(30), a3: 1, a4: 2, a5: 3, a6: 4, a7: 5 }], 20, plain);
    expect(many.split('\n')[0]).toMatch(/^A1 +A2 +A3 +A4 +A5 +A6$/);
    expect(table([{ id: 'abcdef' }], 60, style(true))).toContain('\x1b[1mID');
  });

  it('shows an object as fields, nested lists as tables', () => {
    const d = details({ id: 'd1', name: 'acme.com', tracking: { opens: true, clicks: false }, empty: {}, records: [{ type: 'TXT', name: 'x', value: 'v' }], tags: [] }, 80, plain);
    expect(d).toContain('id               d1');
    expect(d).toContain('tracking.opens   true');
    expect(d).toContain('empty            {}');
    expect(d).toMatch(/\nrecords\nNAME +TYPE +VALUE\nx +TXT +v\n/);
    expect(details({ records: [{ a: 1 }] }, 80, plain)).toBe('\nrecords\nA\n1\n');
    expect(style(true).red('x')).toBe('\x1b[31mx\x1b[39m');
  });

  it('wraps text', () => {
    expect(wrapText('one two three\n\nfour', 9, '  ')).toBe('  one two\n  three\n  four');
  });
});

describe('config', () => {
  it('writes the config readable by the owner only', () => {
    const path = join(tmp(), 'deep', 'zapsmtp', 'config.json');
    writeConfig(path, { profiles: { default: { api_key: 'k' } } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    expect(readConfig(path, () => { throw new Error('no warning expected'); })).toEqual({ profiles: { default: { api_key: 'k' } } });
  });

  it('warns about a config others can read, refuses broken JSON, tolerates odd shapes', () => {
    const dir = tmp();
    const path = join(dir, 'config.json');
    writeFileSync(path, '{"profiles": null}', { mode: 0o644 });
    const warnings: string[] = [];
    expect(readConfig(path, (m) => warnings.push(m))).toEqual({ profiles: {} });
    expect(warnings[0]).toMatch(/can be read by other users: run chmod 600/);
    expect(readConfig(path, (m) => warnings.push(m), 'win32')).toEqual({ profiles: {} });
    expect(warnings).toHaveLength(1);
    writeFileSync(path, 'null');
    expect(readConfig(path, () => undefined)).toEqual({ profiles: {} });
    writeFileSync(path, '{nope');
    expect(() => readConfig(path, () => undefined)).toThrow(/not valid JSON/);
    expect(readConfig(join(dir, 'missing.json'), () => undefined)).toEqual({ profiles: {} });
  });

  it('lives under XDG_CONFIG_HOME, else ~/.config', () => {
    expect(configPath({ XDG_CONFIG_HOME: '/x' })).toBe('/x/zapsmtp/config.json');
    expect(configPath({ HOME: '/home/me' })).toBe('/home/me/.config/zapsmtp/config.json');
    expect(configPath({})).toMatch(/\.config[/\\]zapsmtp[/\\]config\.json$/);
  });
});

describe('help', () => {
  it('prints the overview, groups and versions', async () => {
    let r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^zapsmtp \d+\.\d+\.\d+(-[\w.]+)?: the ZapSMTP command line/);
    expect(r.out).toContain('webhooks verify');
    r = await run(['--version']);
    expect(r.out).toMatch(/^zapsmtp-cli \d+\.\d+\.\d+(-[\w.]+)? \(zapsmtp-node \d+\.\d+\.\d+(-[\w.]+)?\)\n$/);
    expect(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version).toBe(r.out.split(' ')[1]);
    r = await run(['emails']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/receiving attachments get <id> <aid>/);
    r = await run(['help', 'emails', 'receiving']);
    expect(r.out).toMatch(/^  list +List received emails$/m);
    expect((await run(['help'])).out).toContain('Commands');
    r = await run(['emails', 'send', '--help']);
    expect(r.out).toContain('--idempotency-key');
    expect(r.out).toContain('Also: --tag <name=value>');
    expect((await run(['template-assets', 'upload', '--help'])).out).toContain('--file <path>');
    expect((await run(['emails', 'send-batch', '--help'])).out).toContain("--json '<list>'");
    expect((await run(['emails', 'list', '--help'])).out).toContain('--all fetches every page');
    expect((await run(['login', '--help'])).out).toContain('Commands');
    expect((await run(['send', '-h'])).out).toContain('zapsmtp send [flags]');
  });

  it('clips long titles in group help', () => {
    const cmds = commands().filter((c) => c.words[0] === 'emails');
    const text = groupHelp(['emails'], cmds, 50, plain);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(56);
    expect(commandHelp(commands().find((c) => c.op.id === 'usage')!, 80, plain)).toContain('zapsmtp usage get\n');
  });

  it('refuses unknown commands and flags with exit code 2', async () => {
    let r = await run(['nope']);
    expect(r).toMatchObject({ code: 2, err: "zapsmtp: Unknown command 'nope'\nRun 'zapsmtp --help' for usage.\n" });
    r = await run(['emails', 'nope']);
    expect(r.err).toContain("Unknown command 'emails nope'\nRun 'zapsmtp emails --help'");
    r = await run(['--bogus']);
    expect(r).toMatchObject({ code: 2, err: expect.stringContaining('Unknown flag --bogus') });
    r = await run(['emails', 'list', '--bogus', 'x']);
    expect(r.err).toContain("Unknown flag --bogus\nRun 'zapsmtp emails list --help'");
    r = await run(['emails', 'list', '--output', 'xml']);
    expect(r.err).toContain('--output is table or json');
    r = await run(['emails', 'get']);
    expect(r.err).toContain('Missing <id>');
    r = await run(['emails', 'get', 'a', 'b']);
    expect(r.err).toContain('Too many arguments: b');
    r = await run(['whoami', 'x']);
    expect(r.err).toContain('Too many arguments: x');
    r = await run(['test', '--bogus']);
    expect(r.err).toContain('Unknown flag --bogus');
    expect((await run(['emails', 'list', '--no-color', '--bogus'], { errTty: true, env: { NO_COLOR: undefined } })).err).not.toContain('\x1b[');
    expect((await run(['nope'], { errTty: true, env: { NO_COLOR: undefined } })).err).toContain('\x1b[31mzapsmtp:');
  });
});

describe('running operations', () => {
  const ok = (body: unknown = { id: 'x' }) => fakeFetch(() => [200, body]);

  it('warns when the saved config can be read by others', async () => {
    const home = tmp();
    mkdirSync(join(home, 'zapsmtp'), { recursive: true });
    writeFileSync(join(home, 'zapsmtp', 'config.json'), JSON.stringify({ profiles: { default: { api_key: 'zap_saved' } } }), { mode: 0o644 });
    const r = await run(['usage', 'get'], { env: { XDG_CONFIG_HOME: home }, fetch: fakeFetch(() => [200, { object: 'usage' }]).fetch });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/^warning: .*config\.json can be read by other users: run chmod 600/);
  });

  it('needs a key, and takes --key over ZAP_API_KEY over the profile', async () => {
    let r = await run(['usage', 'get']);
    expect(r).toMatchObject({ code: 2, err: expect.stringContaining('No API key: run zapsmtp login, set ZAP_API_KEY, or pass --key') });
    r = await run(['usage', 'get', '--profile', 'work']);
    expect(r.err).toContain('No saved profile work: run zapsmtp login --profile work');
    const home = tmp();
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'cfg') };
    writeConfig(join(home, 'cfg', 'zapsmtp', 'config.json'), { profiles: { default: { api_key: 'zap_profile', base_url: 'http://saved.test/v1' }, work: { api_key: 'zap_work' } } });
    const f = ok({ object: 'usage' });
    await run(['usage', 'get'], { env, fetch: f.fetch });
    await run(['usage', 'get', '--profile', 'work', '--base-url', 'http://flag.test/v1'], { env, fetch: f.fetch });
    await run(['usage', 'get'], { env: { ...env, ZAP_API_KEY: 'zap_env', ZAP_PROFILE: 'work' }, fetch: f.fetch });
    await run(['usage', 'get', '--key', 'zap_flag'], { env: { ...env, ZAP_API_KEY: 'zap_env' }, fetch: f.fetch });
    expect(f.requests.map((q) => [q.headers.authorization, q.url.origin])).toEqual([
      ['Bearer zap_profile', 'http://saved.test'], ['Bearer zap_work', 'http://flag.test'], ['Bearer zap_env', 'https://api.zapsmtp.com'], ['Bearer zap_flag', 'http://saved.test'],
    ]);
    expect(f.requests[0].headers['user-agent']).toMatch(/^zapsmtp-cli\/\d+\.\d+\.\d+(-[\w.]+)? \(node\/[\d.]+; zapsmtp-node\/\d+\.\d+\.\d+(-[\w.]+)?\)$/);
  });

  it('prints JSON when piped or asked, tables on a terminal', async () => {
    const f = fakeFetch(() => [200, page([{ id: 'e1', subject: 'Hi', to: ['a@x.com'], created_at: '2026-10-21T15:04:10Z' }], true)]);
    let r = await run(['emails', 'list'], { env: KEYENV, fetch: f.fetch });
    expect(r.json()).toEqual(page([{ id: 'e1', subject: 'Hi', to: ['a@x.com'], created_at: '2026-10-21T15:04:10Z' }], true));
    r = await run(['emails', 'list', '--limit', '1', '--status', 'bounced'], { env: KEYENV, fetch: f.fetch, tty: true });
    expect(r.out).toMatch(/^ID +TO +SUBJECT +CREATED_AT\ne1 +a@x.com +Hi +2026-10-21T15:04:10Z\n$/);
    expect(r.err).toBe('More results: add --all, or --before e1 for the next page.\n');
    r = await run(['emails', 'list', '--json'], { env: KEYENV, fetch: f.fetch, tty: true });
    expect(r.json().data[0].id).toBe('e1');
    r = await run(['emails', 'list', '--output', 'json'], { env: KEYENV, fetch: f.fetch, tty: true });
    expect(r.json().data[0].id).toBe('e1');
    r = await run(['emails', 'list', '--output', 'table'], { env: KEYENV, fetch: f.fetch });
    expect(r.out).toMatch(/^ID/);
    r = await run(['emails', 'get', 'e1'], { env: { ...KEYENV, NO_COLOR: undefined }, fetch: ok({ id: 'e1', subject: 'Hi' }).fetch, tty: true });
    expect(r.out).toBe('\x1b[2mid     \x1b[22m  e1\n\x1b[2msubject\x1b[22m  Hi\n');
    r = await run(['emails', 'get', 'e1'], { env: { ...KEYENV, NO_COLOR: '1' }, fetch: ok({ id: 'e1' }).fetch, tty: true });
    expect(r.out).toBe('id  e1\n');
  });

  it('hints at more results without a cursor to give', async () => {
    const f = fakeFetch(() => [200, page([{ id: 'w1' }], true)]);
    const r = await run(['webhooks', 'list'], { env: KEYENV, fetch: f.fetch, tty: true });
    expect(r.err).toBe('More results: add --all.\n');
  });

  it('prints Done for an empty answer, nothing in JSON', async () => {
    const f = fakeFetch(() => [204, undefined]);
    expect((await run(['domains', 'delete', 'd1'], { env: KEYENV, fetch: f.fetch, tty: true })).out).toBe('Done.\n');
    expect((await run(['domains', 'delete', 'd1'], { env: KEYENV, fetch: f.fetch })).out).toBe('');
  });

  it('walks every page with --all', async () => {
    const f = fakeFetch((q) => {
      const before = q.url.searchParams.get('before');
      return [200, before === null ? page([{ id: 'a' }, { id: 'b' }], true) : before === 'b' ? page([{ id: 'c' }], true) : page([], false)];
    });
    const r = await run(['emails', 'list', '--limit', '2', '--all'], { env: KEYENV, fetch: f.fetch });
    expect(r.json()).toEqual({ object: 'list', data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], has_more: false });
    expect(f.requests.map((q) => q.url.search)).toEqual(['?limit=2', '?limit=2&before=b', '?limit=2&before=c']);
    expect((await run(['usage', 'get', '--all'], { env: KEYENV })).err).toContain('usage get is not a list: --all does not apply');
  });

  it('asks for the largest page with --all unless --limit is given', async () => {
    const f = fakeFetch(() => [200, page([], false)]);
    await run(['emails', 'list', '--all'], { env: KEYENV, fetch: f.fetch });
    expect(f.requests.map((q) => q.url.search)).toEqual(['?limit=100']);
  });

  it('exits 1 on API errors with code, message and request id', async () => {
    const f = fakeFetch(() => [422, { message: 'invalid to address', error: { code: 'invalid_parameter', message: 'invalid to address' } }, { 'x-request-id': 'req_9' }]);
    let r = await run(['emails', 'send', '--from', 'a@x.com', '--to', 'bad', '--text', 't'], { env: KEYENV, fetch: f.fetch });
    expect(r).toMatchObject({ code: 1, out: '', err: 'Error: invalid to address\n  status 422 · code invalid_parameter · request id req_9\n' });
    r = await run(['usage', 'get'], { env: KEYENV, fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    expect(r).toMatchObject({ code: 1, err: 'Error: fetch failed\n' });
    r = await run(['emails', 'get', '..'], { env: KEYENV, fetch: f.fetch });
    expect(r.err).toBe('Error: id must not be ".."\n  code invalid_parameter\n');
    const home = tmp();
    mkdirSync(join(home, 'zapsmtp'), { recursive: true });
    writeFileSync(join(home, 'zapsmtp', 'config.json'), '{broken', { mode: 0o600 });
    r = await run(['usage', 'get'], { env: { XDG_CONFIG_HOME: home } });
    expect(r).toMatchObject({ code: 1, err: expect.stringMatching(/^Error: .*config\.json is not valid JSON/) });
  });

  it('builds the request from typed flags', async () => {
    const f = ok();
    const dir = tmp();
    writeFileSync(join(dir, 'body.html'), '<p>Hi</p>');
    writeFileSync(join(dir, 'invoice.pdf'), 'PDF');
    const r = await run(['emails', 'send', '--from', 'a@x.com', '--to', 'b@y.com', '--to=c@y.com', '--subject', 'Hi', '--html-file', 'body.html',
      '--tag', 'plan=pro', '--tags', 'k=v=w', '--metadata', 'order=42', '--header', 'X-A=1', '--attach', 'invoice.pdf',
      '--attachments', '{"filename":"a.txt","path":"https://x/a.txt"}', '--tracking.opens=false', '--tracking.clicks', '--template.id', 'welcome',
      '--template.variables.name', 'Ann', '--template.variables.n', '3', '--stream', 'broadcast', '--scheduled-at', 'in 1 hour', '--idempotency-key', 'idem-1'],
    { env: KEYENV, fetch: f.fetch, cwd: dir });
    expect(r.err).toBe('');
    expect(f.requests[0].body).toEqual({
      from: 'a@x.com', to: ['b@y.com', 'c@y.com'], subject: 'Hi', html: '<p>Hi</p>', tags: [{ name: 'plan', value: 'pro' }, { name: 'k', value: 'v=w' }],
      metadata: { order: '42' }, headers: { 'X-A': '1' },
      attachments: [{ filename: 'invoice.pdf', content: 'UERG', content_type: 'application/pdf' }, { filename: 'a.txt', path: 'https://x/a.txt' }],
      tracking: { opens: false, clicks: true }, template: { id: 'welcome', variables: { name: 'Ann', n: 3 } }, stream: 'broadcast', scheduled_at: 'in 1 hour',
    });
    expect(f.requests[0].headers['idempotency-key']).toBe('idem-1');
  });

  it('merges --json, --json-file and stdin with flags on top', async () => {
    const f = ok();
    const dir = tmp();
    writeFileSync(join(dir, 'tpl.json'), JSON.stringify({ name: 'From file', html: '<p>x</p>', variables: { a: 1 } }));
    await run(['templates', 'create', '--json-file', 'tpl.json', '--name', 'Flag', '--variable', 'b=true', '--publish', '--design', '{"rows":[]}', '--variable-schema', '[{"name":"a","type":"number"}]'], { env: KEYENV, fetch: f.fetch, cwd: dir });
    expect(f.requests[0].body).toEqual({ name: 'Flag', html: '<p>x</p>', variables: { a: 1, b: true }, publish: true, design: { rows: [] }, variable_schema: [{ name: 'a', type: 'number' }] });
    await run(['templates', 'update', 't1', '--json', '{"subject":"S"}', '--no-publish', '--design', 'not json'], { env: KEYENV, fetch: f.fetch });
    expect(f.requests[1].body).toEqual({ subject: 'S', publish: false, design: 'not json' });
    await run(['templates', 'update', 't1', '--data-file', '-', '--publish=no'], { env: KEYENV, fetch: f.fetch, stdin: '{"text":"T"}' });
    expect(f.requests[2].body).toEqual({ text: 'T', publish: false });
    await run(['emails', 'send', '--data', '{"from":"a@x.com","to":"b@y.com"}', '--text-file', '-'], { env: KEYENV, fetch: f.fetch, stdin: 'body' });
    expect(f.requests[3].body).toEqual({ from: 'a@x.com', to: 'b@y.com', text: 'body' });
    await run(['webhooks', 'create', '--url', 'https://x', '--event', 'email.sent', '--events', 'email.bounced', '--filter', '{"actions":["buy"]}'], { env: KEYENV, fetch: f.fetch });
    expect(f.requests[4].body).toEqual({ url: 'https://x', events: ['email.sent', 'email.bounced'], filter: { actions: ['buy'] } });
    await run(['emails', 'list', '--metadata', 'k=v', '--days', '-1'], { env: KEYENV, fetch: f.fetch });
    expect(f.requests[5].url.search).toBe('?metadata%5Bk%5D=v&days=-1');
    await run(['webhooks', 'update', 'w1', '--filter.actions', '["a"]', '--enabled=1'], { env: KEYENV, fetch: f.fetch });
    expect(f.requests[6].body).toEqual({ filter: { actions: ['a'] }, enabled: true });
    await run(['emails', 'send', '--json', '{"from":"a@x.com","to":"b@y.com","tracking":{"opens":true}}', '--tracking.clicks=off'], { env: KEYENV, fetch: f.fetch });
    expect(f.requests[7].body.tracking).toEqual({ opens: true, clicks: false });
    await run(['templates', 'render-source', '--html', 'x', '--variables', 'n=1.5'], { env: KEYENV, fetch: f.fetch });
    expect(f.requests[8].body).toEqual({ html: 'x', variables: { n: 1.5 } });
    await run(['emails', 'send-batch', '--json', '[{"to":"b@y.com","text":"t"}]', '--idempotency-key', 'k'], { env: { ...KEYENV, ZAP_SENDER: 'Me <me@x.com>' }, fetch: f.fetch });
    expect(f.requests[9].body).toEqual([{ from: 'Me <me@x.com>', to: 'b@y.com', text: 't' }]);
  });

  it('uploads a file where the operation takes one', async () => {
    const f = ok({ id: 'a1' });
    const dir = tmp();
    writeFileSync(join(dir, 'logo.png'), 'PNG');
    const r = await run(['template-assets', 'upload', '--file', 'logo.png', '--name', 'Logo'], { env: KEYENV, fetch: f.fetch, cwd: dir });
    expect(r.code).toBe(0);
    const form = f.requests[0].body as FormData;
    expect(form.get('name')).toBe('Logo');
    expect((form.get('file') as File).name).toBe('logo.png');
    expect((await run(['template-assets', 'upload', '--url', 'https://x/l.png'], { env: KEYENV, fetch: f.fetch })).code).toBe(0);
    expect(f.requests[1].body).toEqual({ url: 'https://x/l.png' });
  });

  it('reports a failure that is neither an API nor a usage error', async () => {
    const stdout = { write: () => { throw 'stdout is gone'; } } as any;
    const { main } = await import('../src/main.js');
    const err: string[] = [];
    const code = await main(['--version'], { stdout, stderr: { write: (s: string) => err.push(s) } as any, stdin: process.stdin, env: {}, cwd: '.' });
    expect(code).toBe(1);
    expect(err.join('')).toBe('Error: stdout is gone\n');
  });

  it('refuses malformed flag values with exit code 2', async () => {
    const f = ok();
    const bad = async (argv: string[], msg: string | RegExp, o = {}) => {
      const r = await run(argv, { env: KEYENV, fetch: f.fetch, ...o });
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err).toMatch(msg);
    };
    await bad(['emails', 'list', '--limit', 'x'], '--limit takes a whole number, not x');
    await bad(['templates', 'create', '--name', 'n', '--publish=maybe'], '--publish is true or false, not maybe');
    await bad(['templates', 'create', '--name', 'n', '--no-publish=1'], '--no-publish takes no value');
    await bad(['emails', 'send', '--to', 'x', '--metadata', 'novalue'], '--metadata takes key=value, not novalue');
    await bad(['emails', 'send', '--to', 'x', '--tag', '=v'], '--tag takes key=value');
    await bad(['emails', 'send', '--to', 'x', '--tracking', '[1]'], '--tracking takes a JSON object, or set fields with --tracking.<field>');
    await bad(['emails', 'send', '--to', 'x', '--tracking', '{bad'], '--tracking is not valid JSON');
    await bad(['emails', 'send', '--to', 'x', '--attachments', '3'], '--attachments takes a JSON object');
    await bad(['emails', 'send', '--to', 'x', '--tracking.nope', '1'], '--tracking.nope: tracking has opens, clicks, replies');
    await bad(['emails', 'send', '--to', 'x', '--tracking.opens.x', '1'], 'Unknown flag --tracking.opens.x');
    await bad(['emails', 'send', '--to', 'x', '--template.variables.a'], '--template.variables.a needs a value');
    await bad(['emails', 'send', '--to', 'x', '--template.id'], '--template.id needs a value');
    await bad(['emails', 'send', '--to', 'x', '--tracking.opens=perhaps'], '--tracking.opens is true or false');
    await bad(['emails', 'send', '--json', '{bad'], '--json is not valid JSON');
    await bad(['emails', 'send', '--json', '[1]'], '--json must be a JSON object');
    await bad(['emails', 'send', '--json-file', '-'], /- is not valid JSON/, { stdin: 'nope' });
    await bad(['emails', 'send-batch', '--json', '{"to":"x"}'], 'Give the emails as a JSON list');
    await bad(['emails', 'send', '--text', 'x'], 'Missing --to');
    await bad(['domains', 'create'], 'Missing --name');
    await bad(['usage', 'get', '--idempotency-key', 'k'], 'usage get takes no --idempotency-key');
    await bad(['emails', 'list', '--limit'], '--limit needs a value');
  });

  it('accepts numbers where the API takes them', async () => {
    const f = ok();
    await run(['stats', 'metrics', '--from', 'x'], { env: KEYENV, fetch: f.fetch });
    expect(f.requests[0].url.search).toBe('?from=x');
    const r = await run(['template-timers', 'create', '--end', 'e', '--width', 'wide', '--digit-color', 'a', '--label-color', 'b', '--background', 'c'], { env: KEYENV, fetch: f.fetch });
    expect(r.err).toContain('--width takes a whole number, not wide');
    const fakeNumberOp = flagSpecs({ ...API.operations[0], body: [{ name: 'ratio', type: { k: 'number' }, required: false, doc: '' }], query: [], options: [] });
    expect(fakeNumberOp.get('ratio')!.kind).toBe('value');
  });
});

describe('number flags', () => {
  it('parses decimals and refuses the rest', async () => {
    // no operation takes a plain number flag today; the parser still must
    const { scalar } = await import('../src/values.js');
    expect(scalar({ k: 'number' }, '1.5', '--n', [])).toBe(1.5);
    expect(() => scalar({ k: 'number' }, 'x', '--n', [])).toThrow('--n takes a number, not x');
    expect(() => scalar({ k: 'number' }, ' ', '--n', [])).toThrow('takes a number');
  });
});

describe('login, logout, whoami', () => {
  const usage = { object: 'usage', month: '2026-10', sent: 5, included: 3000, limit: null, plan: { id: 'free', name: 'Free', retention_days: 3 } };

  it('checks the key, then saves it 0600 in the profile', async () => {
    const home = tmp();
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'cfg'), ZAP_BASE_URL: undefined };
    const f = fakeFetch(() => [200, usage]);
    let r = await run(['login'], { env, fetch: f.fetch, stdin: 'zap_live_secret\n', tty: true });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`Logged in as profile default (plan Free). Saved to ${join(home, 'cfg', 'zapsmtp', 'config.json')}\n`);
    expect(r.out + r.err).not.toContain('zap_live_secret');
    const path = join(home, 'cfg', 'zapsmtp', 'config.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ profiles: { default: { api_key: 'zap_live_secret' } } });
    expect(f.requests[0].url.pathname).toBe('/v1/usage');
    expect(f.requests[0].headers.authorization).toBe('Bearer zap_live_secret');
    // a second profile, with its own base URL, from --key
    r = await run(['login', '--profile', 'staging', '--key', 'zap_test_two', '--base-url', 'http://staging.test/v1'], { env, fetch: f.fetch });
    expect(r.json()).toEqual({ profile: 'staging', plan: 'Free', restricted: false, path });
    expect(JSON.parse(readFileSync(path, 'utf8')).profiles).toEqual({ default: { api_key: 'zap_live_secret' }, staging: { api_key: 'zap_test_two', base_url: 'http://staging.test/v1' } });
    // whoami never shows the key
    r = await run(['whoami', '--profile', 'staging'], { env, fetch: f.fetch, tty: true, columns: 400 });
    expect(r.out).toContain('mode        test');
    expect(r.out).toContain('plan        Free');
    expect(r.out).toContain(`key_source  profile staging (${path})`);
    expect(r.out).not.toContain('zap_test_two');
    r = await run(['whoami'], { env, fetch: f.fetch });
    expect(r.json()).toEqual({ key_source: `profile default (${path})`, mode: 'live', base_url: 'https://api.zapsmtp.com/v1', access: 'full', plan: 'Free', month: '2026-10', sent: 5, included: 3000, limit: null });
    // logout
    r = await run(['logout', '--profile', 'staging'], { env, tty: true });
    expect(r.out).toBe('Removed staging\n');
    r = await run(['logout', '--profile', 'staging'], { env });
    expect(r.json()).toEqual({ removed: [] });
    r = await run(['logout', '--profile', 'staging'], { env, tty: true });
    expect(r.out).toBe('No saved profile staging\n');
    r = await run(['logout', '--all'], { env });
    expect(r.json()).toEqual({ removed: ['default'] });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ profiles: {} });
  });

  it('prompts without echo on a terminal', async () => {
    const f = fakeFetch(() => [200, usage]);
    const r = await run(['login'], { fetch: f.fetch, stdin: 'zap_tyX\u007fpo\r', stdinTty: true });
    expect(r.code).toBe(0);
    expect(r.err).toBe('ZapSMTP API key: \n');
    expect(r.rawModes).toEqual([true, false]);
    expect(f.requests[0].headers.authorization).toBe('Bearer zap_typo');
    for (const end of ['\n', '\u0004']) {
      const g = fakeFetch(() => [200, usage]);
      expect((await run(['login'], { fetch: g.fetch, stdin: `zap_ab\bc${end}`, stdinTty: true })).code).toBe(0);
      expect(g.requests[0].headers.authorization).toBe('Bearer zap_ac');
    }
    const g = fakeFetch(() => [200, usage]);
    expect((await run(['login'], { fetch: g.fetch, stdin: ['zap_', 'chunked', '\r'], stdinTty: true })).code).toBe(0);
    expect(g.requests[0].headers.authorization).toBe('Bearer zap_chunked');
    const c = await run(['login'], { stdin: 'zap\u0003', stdinTty: true });
    expect(c).toMatchObject({ code: 2, err: expect.stringContaining('Cancelled') });
  });

  it('never saves a key the API refuses; keeps a key limited to sending', async () => {
    const home = tmp();
    const env = { XDG_CONFIG_HOME: home };
    let r = await run(['login'], { env, stdin: 'zap_bad', fetch: fakeFetch(() => [401, { message: 'Invalid API key', error: { code: 'invalid_api_key', message: 'Invalid API key' } }]).fetch });
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('Invalid API key') });
    expect(() => statSync(join(home, 'zapsmtp', 'config.json'))).toThrow();
    const restricted = fakeFetch(() => [403, { message: 'This key may only send', error: { code: 'restricted_api_key', message: 'This key may only send' } }]);
    r = await run(['login'], { env, stdin: 'zap_send_only', fetch: restricted.fetch, tty: true });
    expect(r.out).toContain('(a key limited to sending)');
    r = await run(['whoami'], { env, fetch: restricted.fetch });
    expect(r.json()).toMatchObject({ access: 'sending only', mode: 'unknown' });
    expect(r.json()).not.toHaveProperty('plan');
    r = await run(['whoami'], { env, fetch: fakeFetch(() => [500, {}]).fetch });
    expect(r.code).toBe(1);
    r = await run(['login'], { env, stdin: '   ' });
    expect(r).toMatchObject({ code: 2, err: expect.stringContaining('No API key given') });
  });
});

describe('send and test', () => {
  const SIM = { domain: 'simulator.zapsmtp.com', note: '', scenarios: [
    { address: 'delivered@simulator.zapsmtp.com', event: 'email.delivered', result: '250' },
    { address: 'bounced@simulator.zapsmtp.com', event: 'email.bounced', result: '550' },
    { address: 'bounce+421+4.7.0+x@simulator.zapsmtp.com', event: 'email.delivery_delayed', result: 'any' },
  ] };
  const sim = () => fakeFetch((q) => q.url.pathname === '/v1/simulator' ? [200, SIM] : [200, { id: 'em_1' }]);

  it('send is emails send with From from ZAP_SENDER', async () => {
    const f = sim();
    let r = await run(['send', '--to', 'j@example.org', '--subject', 'Hi', '--text', 'Hello'], { env: { ...KEYENV, ZAP_SENDER: 'Acme <a@acme.com>' }, fetch: f.fetch, tty: true });
    expect(r.out).toBe('id  em_1\n');
    expect(f.requests[0].body).toEqual({ from: 'Acme <a@acme.com>', to: ['j@example.org'], subject: 'Hi', text: 'Hello' });
    r = await run(['send', '--from', 'b@acme.com', '--to', 'j@example.org', '--text', 'x'], { env: { ...KEYENV, ZAP_SENDER: 'a@acme.com' }, fetch: f.fetch });
    expect(f.requests[1].body.from).toBe('b@acme.com');
    r = await run(['send', '--text', 'x'], { env: KEYENV, fetch: f.fetch });
    expect(r.err).toContain("Missing --to\nRun 'zapsmtp send --help'");
  });

  it('test sends to the simulator', async () => {
    const f = sim();
    let r = await run(['test', '--from', 'a@acme.com'], { env: KEYENV, fetch: f.fetch });
    expect(r.json()).toEqual({ id: 'em_1', to: 'delivered@simulator.zapsmtp.com', expected_event: 'email.delivered', expected_result: '250' });
    expect(f.requests[1].body).toEqual({ from: 'a@acme.com', to: 'delivered@simulator.zapsmtp.com', subject: 'ZapSMTP test: delivered', text: 'A test of the delivered outcome, sent through the ZapSMTP simulator.' });
    r = await run(['test', 'Bounced@simulator.zapsmtp.com', '--subject', 'S', '--html', '<p>x</p>'], { env: { ...KEYENV, ZAP_SENDER: 's@acme.com' }, fetch: f.fetch, tty: true });
    expect(r.out).toContain('expected_event   email.bounced');
    expect(r.out).toContain('zapsmtp emails get em_1');
    expect(f.requests[3].body).toEqual({ from: 's@acme.com', to: 'bounced@simulator.zapsmtp.com', subject: 'S', html: '<p>x</p>' });
    r = await run(['test', 'bounce+550+5.1.1', '--from', 'a@acme.com', '--text', 'own'], { env: KEYENV, fetch: f.fetch });
    expect(r.json()).toMatchObject({ to: 'bounce+550+5.1.1@simulator.zapsmtp.com', expected_result: 'bounce+550+5.1.1' });
    r = await run(['test', 'exploded', '--from', 'a@acme.com'], { env: KEYENV, fetch: f.fetch });
    expect(r).toMatchObject({ code: 2, err: expect.stringContaining('Unknown scenario exploded. Scenarios: delivered, bounced, or bounce+') });
    r = await run(['test'], { env: KEYENV, fetch: f.fetch });
    expect(r.err).toContain('Missing --from (or set ZAP_SENDER)');
  });
});

describe('webhooks verify', () => {
  it('checks every shared vector', async () => {
    for (const v of vectors) {
      const dir = tmp();
      writeFileSync(join(dir, 'body.json'), v.payload);
      const r = await run(['webhooks', 'verify', '--secret', v.secret, '--signature', v.header, '--payload-file', 'body.json', '--now', String(v.now), '--tolerance', String(v.tolerance)], { cwd: dir });
      expect(r.code, v.name).toBe(v.valid ? 0 : 1);
      expect(r.json().valid).toBe(v.valid);
    }
  });

  it('reads the secret from the environment and the body from stdin or a flag', async () => {
    const v = vectors[0];
    let r = await run(['webhooks', 'verify', '--signature', v.header, '--payload-file', '-', '--now', String(v.now)], { env: { ZAP_WEBHOOK_SECRET: v.secret }, stdin: v.payload, tty: true });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Valid signature: 1 event\nID +TYPE +CREATED_AT\nevt_1 +email\.delivered/);
    const batch = vectors.find((x) => x.batch && x.valid);
    r = await run(['webhooks', 'verify', '--secret', batch.secret, '--signature', batch.header, '--payload', batch.payload, '--now', String(batch.now)], { tty: true });
    expect(r.out).toMatch(/^Valid signature: \d+ events\n/);
    r = await run(['webhooks', 'verify', '--secret', v.secret, '--signature', v.header, '--payload', v.payload], { tty: true });
    expect(r).toMatchObject({ code: 1, out: '', err: 'Invalid signature: Webhook signature is too old (or from the future)\n' });
  });

  it('needs a secret, a signature and a body', async () => {
    expect((await run(['webhooks', 'verify', '--signature', 's', '--payload', 'p'])).err).toContain('Missing --secret');
    expect((await run(['webhooks', 'verify', '--secret', 's', '--payload', 'p'])).err).toContain('Missing --signature');
    expect((await run(['webhooks', 'verify', '--secret', 's', '--signature', 's'])).err).toContain('Missing --payload-file');
    expect((await run(['webhooks', 'verify', '--secret', 's', '--signature', 's', '--payload', 'p', '--now', 'x'])).err).toContain('--now takes a whole number of seconds, not x');
  });
});
