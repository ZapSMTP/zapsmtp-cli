// Hand-written commands: login, logout, whoami, test, webhooks verify.
// (send is emails send with a default From: see main.ts.)
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PermissionError, verifyWebhookEvents, type Usage } from 'zapsmtp';
import { UsageError } from './args.js';
import { readConfig, writeConfig } from './config.js';
import type { Ctx } from './main.js';
import { details, json, table } from './output.js';

/** Each helper's own flags (global flags aside); true marks one that takes a value. */
export const HELPER_FLAGS: Record<string, Record<string, boolean>> = {
  login: {},
  logout: {},
  whoami: {},
  test: { from: true, subject: true, text: true, html: true },
  'webhooks verify': { secret: true, signature: true, payload: true, 'payload-file': true, tolerance: true, now: true },
};

export async function runHelper(name: string, ctx: Ctx): Promise<number> {
  const max = name === 'test' ? 1 : 0;
  if (ctx.positionals.length > max) throw new UsageError(`Too many arguments: ${ctx.positionals.slice(max).join(' ')}`, ctx.words);
  switch (name) {
    case 'login': return login(ctx);
    case 'logout': return logout(ctx);
    case 'whoami': return whoami(ctx);
    case 'test': return test(ctx);
    default: return verify(ctx);
  }
}

const str = (v: string | true | undefined): string | undefined => typeof v === 'string' ? v : undefined;

// ---- login, logout, whoami -------------------------------------------------

async function login(ctx: Ctx): Promise<number> {
  const profile = str(ctx.flag('profile')) ?? ctx.io.env.ZAP_PROFILE ?? 'default';
  const baseUrl = str(ctx.flag('base-url')) ?? ctx.io.env.ZAP_BASE_URL;
  const key = (str(ctx.flag('key')) ?? (ctx.io.stdin.isTTY ? await prompt(ctx, 'ZapSMTP API key: ') : await ctx.readText('-'))).trim();
  if (!key) throw new UsageError('No API key given', ctx.words);
  // a key the API refuses (401) is never saved; a key limited to sending (403) is
  let usage: Usage | null = null;
  try {
    usage = await ctx.client(key, baseUrl).usage.get();
  } catch (err) {
    if (!(err instanceof PermissionError)) throw err;
  }
  const config = readConfig(ctx.configPath, ctx.warn);
  config.profiles[profile] = baseUrl ? { api_key: key, base_url: baseUrl } : { api_key: key };
  writeConfig(ctx.configPath, config);
  const plan = usage ? usage.plan.name : null;
  if (ctx.json) ctx.out(json({ profile, plan, restricted: !usage, path: ctx.configPath }));
  else ctx.out(`${ctx.st.green('Logged in')} as profile ${ctx.st.bold(profile)}${plan ? ` (plan ${plan})` : ' (a key limited to sending)'}. Saved to ${ctx.configPath}\n`);
  return 0;
}

/** Reads a line without echoing it. */
function prompt(ctx: Ctx, question: string): Promise<string> {
  const { stdin, stderr } = ctx.io;
  stderr.write(question);
  stdin.setRawMode?.(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let text = '';
    const done = (fn: () => void) => {
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      stderr.write('\n');
      fn();
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(() => resolve(text));
        if (ch === '\u0003') return done(() => reject(new UsageError('Cancelled')));
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function logout(ctx: Ctx): number {
  const config = readConfig(ctx.configPath, ctx.warn);
  const all = ctx.flag('all') !== undefined;
  const profile = str(ctx.flag('profile')) ?? ctx.io.env.ZAP_PROFILE ?? 'default';
  const removed = all ? Object.keys(config.profiles) : profile in config.profiles ? [profile] : [];
  for (const p of removed) delete config.profiles[p];
  if (removed.length) writeConfig(ctx.configPath, config);
  if (ctx.json) ctx.out(json({ removed }));
  else ctx.out(removed.length ? `Removed ${removed.map((p) => ctx.st.bold(p)).join(', ')}\n` : `No saved profile ${profile}\n`);
  return 0;
}

async function whoami(ctx: Ctx): Promise<number> {
  const info = ctx.keyInfo();
  const mode = info.key.startsWith('zap_test') ? 'test' : info.key.startsWith('zap_live') ? 'live' : 'unknown';
  let usage: Usage | null = null;
  try {
    usage = await ctx.client().usage.get();
  } catch (err) {
    if (!(err instanceof PermissionError)) throw err;
  }
  const facts = {
    key_source: info.source,
    mode,
    base_url: info.baseUrl ?? 'https://api.zapsmtp.com/v1',
    access: usage ? 'full' : 'sending only',
    ...(usage ? { plan: usage.plan.name, month: usage.month, sent: usage.sent, included: usage.included, limit: usage.limit } : {}),
  };
  ctx.out(ctx.json ? json(facts) : details(facts, ctx.width, ctx.st));
  return 0;
}

// ---- test ------------------------------------------------------------------

async function test(ctx: Ctx): Promise<number> {
  const scenario = (ctx.positionals[0] ?? 'delivered').trim().toLowerCase();
  const from = str(ctx.flag('from')) ?? ctx.io.env.ZAP_SENDER;
  if (!from) throw new UsageError('Missing --from (or set ZAP_SENDER): an address on a verified domain', ctx.words);
  const client = ctx.client();
  const sim = await client.simulator.get();
  const local = scenario.includes('@') ? scenario.slice(0, scenario.lastIndexOf('@')) : scenario;
  const match = sim.scenarios.find((s) => s.address.slice(0, s.address.lastIndexOf('@')) === local);
  if (!match && !/^bounce\+\d{3}(\+[\w.-]+)*$/.test(local)) {
    const names = sim.scenarios.map((s) => s.address.slice(0, s.address.lastIndexOf('@'))).filter((n) => !n.includes('+'));
    throw new UsageError(`Unknown scenario ${scenario}. Scenarios: ${names.join(', ')}, or bounce+<code>[+<x.y.z>][+<words>]`, ctx.words);
  }
  const to = `${local}@${sim.domain}`;
  const html = str(ctx.flag('html'));
  const text = str(ctx.flag('text')) ?? (html === undefined ? `A test of the ${local} outcome, sent through the ZapSMTP simulator.` : undefined);
  const sent = await client.emails.send({ from, to, subject: str(ctx.flag('subject')) ?? `ZapSMTP test: ${local}`, ...(text === undefined ? {} : { text }), ...(html === undefined ? {} : { html }) });
  const result = { id: sent.id, to, expected_event: match?.event ?? 'email.bounced or email.delivery_delayed (by the code)', expected_result: match?.result ?? local };
  ctx.out(ctx.json ? json(result) : details(result, ctx.width, ctx.st) + ctx.st.dim(`Follow it with: zapsmtp emails get ${sent.id}`) + '\n');
  return 0;
}

// ---- webhooks verify -------------------------------------------------------

async function verify(ctx: Ctx): Promise<number> {
  const secret = str(ctx.flag('secret')) ?? ctx.io.env.ZAP_WEBHOOK_SECRET;
  const signature = str(ctx.flag('signature'));
  const file = str(ctx.flag('payload-file'));
  const inline = str(ctx.flag('payload'));
  if (!secret) throw new UsageError('Missing --secret (or set ZAP_WEBHOOK_SECRET)', ctx.words);
  if (signature === undefined) throw new UsageError('Missing --signature: the Zap-Signature header', ctx.words);
  if (inline === undefined && file === undefined) throw new UsageError('Missing --payload-file (or --payload): the raw request body', ctx.words);
  const num = (name: string) => {
    const v = str(ctx.flag(name));
    if (v !== undefined && !/^\d+$/.test(v)) throw new UsageError(`--${name} takes a whole number of seconds, not ${v}`, ctx.words);
    return v === undefined ? undefined : Number(v);
  };
  const tolerance = num('tolerance');
  const now = num('now');
  // the body exactly as received: bytes, not text, so nothing is re-encoded
  const payload = inline ?? (file === '-' ? Buffer.from(await ctx.readText('-'), 'utf8') : await readFile(resolve(ctx.io.cwd, file!)));
  try {
    const events = verifyWebhookEvents(payload, signature, secret, { tolerance, now });
    if (ctx.json) ctx.out(json({ valid: true, events }));
    else ctx.out(`${ctx.st.green('Valid signature')}: ${events.length} event${events.length === 1 ? '' : 's'}\n${table(events as unknown as Record<string, unknown>[], ctx.width, ctx.st)}`);
    return 0;
  } catch (err) {
    const reason = (err as Error).message;
    if (ctx.json) ctx.out(json({ valid: false, reason }));
    ctx.io.stderr.write(`${ctx.errSt.red('Invalid signature:')} ${reason}\n`);
    return 1;
  }
}

