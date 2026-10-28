// The zapsmtp command: finds the command, parses its flags, calls the API
// through the Node SDK and prints the result. Exit codes: 0 ok, 1 API error
// (or a failed check), 2 usage error.
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { attachmentFromFile, VERSION as SDK_VERSION, ZapSMTP, ZapSMTPError } from 'zapsmtp';
import { invoke, nextPageQuery, request, sdkTarget, type Operation } from './generated/model.js';
import { API } from './generated/api.js';
import { GLOBAL_FLAGS, leadingWords, parse, UsageError, type RawFlag } from './args.js';
import { commands, flagSpecs, kebab, type Command, type FlagSpec } from './commands.js';
import { configPath, readConfig } from './config.js';
import { commandHelp, groupHelp, mainHelp } from './help.js';
import { HELPER_FLAGS, runHelper } from './helpers.js';
import { details, json, style, table, type Style } from './output.js';
import { bool, jsonish, mapValue, pair, parseJson, scalar } from './values.js';
import { VERSION } from './version.js';

export interface IO {
  stdout: Writable & { isTTY?: boolean; columns?: number };
  stderr: Writable & { isTTY?: boolean };
  stdin: Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown };
  env: Record<string, string | undefined>;
  cwd: string;
  /** for tests: the fetch the SDK uses */
  fetch?: typeof fetch;
}

export interface KeyInfo {
  key: string;
  source: string;
  profile: string;
  baseUrl?: string;
}

/** What a command needs: output, flags, and the API client. */
export interface Ctx {
  io: IO;
  words: string[];
  st: Style;
  errSt: Style;
  json: boolean;
  width: number;
  flags: RawFlag[];
  positionals: string[];
  /** the last value of a flag: a string, true when given without one, undefined when absent */
  flag(name: string): string | true | undefined;
  /** the last value given to a flag, ignoring bare uses (--json is output, --json '{...}' input) */
  value(name: string): string | undefined;
  keyInfo(): KeyInfo;
  client(key?: string, baseUrl?: string): ZapSMTP;
  configPath: string;
  out(text: string): void;
  warn(text: string): void;
  /** a file's contents, or stdin for - */
  readText(path: string): Promise<string>;
}

export async function main(argv: string[], io: IO): Promise<number> {
  const errSt = style(!!io.stderr.isTTY && !io.env.NO_COLOR && !argv.includes('--no-color'));
  // every key used is scrubbed from error output, whatever the API echoes
  const keys = new Set<string>();
  const stderr = io.stderr;
  const scrub = (text: string) => [...keys].reduce((t, k) => t.split(k).join('[redacted]'), text);
  const writeErr = (text: string) => stderr.write(scrub(text));
  try {
    return await run(argv, { ...io, stderr: Object.assign(Object.create(stderr), { write: writeErr }) }, keys);
  } catch (err) {
    if (err instanceof UsageError) {
      const cmd = err.command.length ? `zapsmtp ${err.command.join(' ')} --help` : 'zapsmtp --help';
      writeErr(`${errSt.red('zapsmtp:')} ${err.message}\nRun '${cmd}' for usage.\n`);
      return 2;
    }
    if (err instanceof ZapSMTPError) {
      const facts = [err.status ? `status ${err.status}` : '', err.code ? `code ${err.code}` : '', err.requestId ? `request id ${err.requestId}` : ''].filter(Boolean);
      writeErr(`${errSt.red('Error:')} ${err.message}\n${facts.length ? `  ${facts.join(' · ')}\n` : ''}`);
      return 1;
    }
    writeErr(`${errSt.red('Error:')} ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function run(argv: string[], io: IO, keys: Set<string>): Promise<number> {
  const cmds = commands();
  const words = leadingWords(argv);

  if (words[0] === 'help') return run([...words.slice(1), '--help'], io, keys);

  // hand-written commands
  const helper = words[0] === 'webhooks' && words[1] === 'verify' ? 'webhooks verify' : ['login', 'logout', 'whoami', 'send', 'test'].includes(words[0]) ? words[0] : null;
  if (helper) {
    const helperWords = helper.split(' ');
    const sendSpecs = helper === 'send' ? flagSpecs(sendOp()) : null;
    const parsed = parse(argv, (name) => sendSpecs ? takesValue(sendSpecs, name, helperWords, sendOp()) : helperFlag(helper, name, helperWords));
    const ctx = context(io, keys, helperWords, parsed.positionals.slice(helperWords.length), parsed.flags);
    if (ctx.flag('help')) {
      ctx.out(helper === 'send' ? commandHelp({ words: ['send'], op: sendOp() }, ctx.width, ctx.st) : mainHelp(cmds, ctx.st));
      return 0;
    }
    if (helper === 'send') return runOperation(ctx, { words: ['send'], op: sendOp() }, sendSpecs!);
    return runHelper(helper, ctx);
  }

  const cmd = cmds.filter((c) => c.words.every((w, i) => words[i] === w)).sort((a, b) => b.words.length - a.words.length)[0];
  if (!cmd) {
    const parsed = parse(argv, (name) => { throw new UsageError(`Unknown flag --${name}`); });
    const ctx = context(io, keys, [], parsed.positionals, parsed.flags);
    if (!words.length) {
      ctx.out(ctx.flag('version') ? `zapsmtp-cli ${VERSION} (zapsmtp-node ${SDK_VERSION})\n` : mainHelp(cmds, ctx.st));
      return 0;
    }
    let depth = 0;
    while (depth < words.length && cmds.some((c) => words.slice(0, depth + 1).every((w, i) => c.words[i] === w))) depth++;
    if (depth === 0) throw new UsageError(`Unknown command '${words[0]}'`);
    if (depth < words.length) throw new UsageError(`Unknown command '${words.slice(0, depth + 1).join(' ')}'`, words.slice(0, depth));
    ctx.out(groupHelp(words, cmds, ctx.width, ctx.st));
    return 0;
  }

  const specs = flagSpecs(cmd.op);
  const parsed = parse(argv, (name) => takesValue(specs, name, cmd.words, cmd.op));
  const ctx = context(io, keys, cmd.words, parsed.positionals.slice(cmd.words.length), parsed.flags);
  if (ctx.flag('help')) {
    ctx.out(commandHelp(cmd, ctx.width, ctx.st));
    return 0;
  }
  return runOperation(ctx, cmd, specs);
}

const sendOp = (): Operation => commands().find((c) => c.op.resource.join('.') === 'emails' && c.op.method === 'send')!.op;

function helperFlag(helper: string, name: string, words: string[]): boolean {
  const flags = HELPER_FLAGS[helper];
  if (!(name in flags)) throw new UsageError(`Unknown flag --${name}`, words);
  return flags[name];
}

function context(io: IO, keys: Set<string>, words: string[], positionals: string[], flags: RawFlag[]): Ctx {
  const flag = (name: string) => {
    const f = flags.filter((x) => x.name === name).at(-1);
    return f === undefined ? undefined : f.value ?? true;
  };
  const output = flag('output');
  if (output !== undefined && output !== 'json' && output !== 'table') throw new UsageError('--output is table or json', words);
  const value = (name: string) => flags.filter((x) => x.name === name && x.value !== undefined).at(-1)?.value;
  const asJson = output === 'json' || flags.some((x) => x.name === 'json' && x.value === undefined) || (output === undefined && !io.stdout.isTTY);
  const color = !io.env.NO_COLOR && flag('no-color') === undefined;
  const path = configPath(io.env);
  const errSt = style(color && !!io.stderr.isTTY);
  const warn = (text: string) => { io.stderr.write(`${errSt.dim('warning:')} ${text}\n`); };
  const ctx: Ctx = {
    io, words, positionals, flags, flag, value, configPath: path,
    st: style(color && !!io.stdout.isTTY),
    errSt,
    json: asJson,
    width: Math.max(60, io.stdout.columns ?? 100),
    out: (text) => { io.stdout.write(text); },
    warn,
    keyInfo() {
      const profile = str(flag('profile')) ?? io.env.ZAP_PROFILE ?? 'default';
      const saved = readConfig(path, warn).profiles[profile];
      const baseUrl = str(flag('base-url')) ?? io.env.ZAP_BASE_URL ?? saved?.base_url;
      const key = str(flag('key'));
      if (key) return { key, source: '--key', profile, baseUrl };
      if (io.env.ZAP_API_KEY) return { key: io.env.ZAP_API_KEY, source: 'ZAP_API_KEY', profile, baseUrl };
      if (saved?.api_key) return { key: saved.api_key, source: `profile ${profile} (${path})`, profile, baseUrl };
      throw new UsageError(flag('profile') !== undefined
        ? `No saved profile ${profile}: run zapsmtp login --profile ${profile}`
        : 'No API key: run zapsmtp login, set ZAP_API_KEY, or pass --key', words);
    },
    client(key?: string, baseUrl?: string) {
      const info = key ? { key, baseUrl } : ctx.keyInfo();
      keys.add(info.key);
      return new ZapSMTP(info.key, {
        baseUrl: info.baseUrl,
        fetch: io.fetch,
        defaultHeaders: { 'User-Agent': `zapsmtp-cli/${VERSION} (node/${process.versions.node}; zapsmtp-node/${SDK_VERSION})` },
      });
    },
    async readText(p: string) {
      if (p !== '-') return readFile(resolve(io.cwd, p), 'utf8');
      let text = '';
      for await (const chunk of io.stdin) text += chunk;
      return text;
    },
  };
  return ctx;
}

const str = (v: string | true | undefined): string | undefined => typeof v === 'string' ? v : undefined;

/** Whether an operation's flag reads a value; throws for a flag the command does not have. */
function takesValue(specs: Map<string, FlagSpec>, name: string, words: string[], op: Operation): boolean {
  if (name === 'file' && op.multipart) return true;
  const spec = specs.get(name);
  if (spec) return spec.kind !== 'bool';
  if (name.startsWith('no-') && specs.get(name.slice(3))?.kind === 'bool') return false;
  const dot = name.indexOf('.');
  const head = dot > 0 ? specs.get(name.slice(0, dot)) : undefined;
  if (head?.kind === 'object') {
    // --tracking.opens is a boolean: true unless given =false
    const field = name.slice(dot + 1);
    return API.inputs[head.param.type.ref!].fields.find((f) => f.name === field || kebab(f.name) === field)?.type.k !== 'boolean';
  }
  throw new UsageError(`Unknown flag --${name}`, words);
}

// ---- running an operation --------------------------------------------------

async function runOperation(ctx: Ctx, cmd: Command, specs: Map<string, FlagSpec>): Promise<number> {
  const op = cmd.op;
  const words = cmd.words;
  if (ctx.positionals.length !== op.pathParams.length) {
    const want = op.pathParams.map((p) => `<${kebab(p.name)}>`).join(' ');
    throw new UsageError(ctx.positionals.length < op.pathParams.length ? `Missing ${want}` : `Too many arguments: ${ctx.positionals.slice(op.pathParams.length).join(' ')}`, words);
  }

  // --json / --json-file first, flags on top
  const inline = ctx.value('json') ?? ctx.value('data');
  const file = ctx.value('json-file') ?? ctx.value('data-file');
  let base: unknown;
  if (inline !== undefined || file !== undefined) {
    const text = inline ?? await ctx.readText(file!);
    try { base = JSON.parse(text); } catch { throw new UsageError(`${inline !== undefined ? '--json' : file} is not valid JSON`, words); }
  }
  let items: Record<string, unknown>[] | undefined;
  const params: Record<string, unknown> = {};
  if (op.bodyArray) {
    if (!Array.isArray(base)) throw new UsageError('Give the emails as a JSON list: --json \'[...]\' or --json-file <path>', words);
    items = base as Record<string, unknown>[];
  } else if (base !== undefined) {
    if (!base || typeof base !== 'object' || Array.isArray(base)) throw new UsageError('--json must be a JSON object', words);
    Object.assign(params, base);
  }

  const options: Record<string, unknown> = {};
  const optionNames = new Set(op.options.map((o) => o.name));
  let upload: string | undefined;
  const fresh = new Set<string>(); // list parameters a flag has set: flags replace the --json list
  for (const f of ctx.flags) {
    if (f.name in GLOBAL_FLAGS) continue;
    if (f.name === 'file' && op.multipart) { upload = f.value; continue; }
    await applyFlag(ctx, specs, f, optionNames.has(flagParam(specs, f.name)) ? options : params, words, fresh);
  }

  const idem = ctx.flag('idempotency-key');
  if (idem !== undefined) {
    if (!op.idempotent) throw new UsageError(`${words.join(' ')} takes no --idempotency-key`, words);
    options.idempotencyKey = idem;
  }

  // the default sender
  const sender = ctx.io.env.ZAP_SENDER;
  if (op.resource.join('.') === 'emails' && (op.method === 'send' || op.method === 'sendBatch') && sender) {
    for (const e of items ?? [params]) if (e && typeof e === 'object' && (e.from === undefined || e.from === '')) e.from = sender;
  }

  if (!upload) {
    const missing = [...op.query, ...op.body].filter((p) => p.required && params[p.name] === undefined).map((p) => `--${kebab(p.name)}`);
    if (missing.length) throw new UsageError(`Missing ${missing.join(', ')}`, words);
  }

  const all = ctx.flag('all') !== undefined;
  if (all && !op.returns?.page) throw new UsageError(`${words.join(' ')} is not a list: --all does not apply`, words);

  const client = ctx.client();
  let result: unknown;
  if (upload) {
    const target = sdkTarget(client, op);
    const bytes = await readFile(resolve(ctx.io.cwd, upload));
    result = await target[op.multipart!.method](bytes, { name: params.name, filename: basename(upload) }, options);
  } else if (all) {
    const data: unknown[] = [];
    for await (const item of request(client, op, { path: ctx.positionals, params, options }) as AsyncIterable<unknown>) data.push(item);
    result = { object: 'list', data, has_more: false };
  } else {
    result = await invoke(client, op, { path: ctx.positionals, params, items, options });
  }
  print(ctx, op, result, params);
  return 0;
}

function flagParam(specs: Map<string, FlagSpec>, name: string): string {
  const spec = specs.get(name) ?? specs.get(name.replace(/^no-/, '')) ?? specs.get(name.split('.')[0]);
  return spec!.param.name;
}

async function applyFlag(ctx: Ctx, specs: Map<string, FlagSpec>, f: RawFlag, into: Record<string, unknown>, words: string[], fresh: Set<string>): Promise<void> {
  const flagName = `--${f.name}`;
  if (f.name.startsWith('no-') && !specs.has(f.name)) {
    const spec = specs.get(f.name.slice(3))!;
    if (f.value !== undefined) throw new UsageError(`${flagName} takes no value`, words);
    into[spec.param.name] = false;
    return;
  }
  const dot = f.name.indexOf('.');
  if (dot > 0 && !specs.has(f.name)) return setField(specs.get(f.name.slice(0, dot))!, f.name.slice(dot + 1), f.value, into, words);

  const spec = specs.get(f.name)!;
  const p = spec.param;
  const v = f.value as string;
  const push = (x: unknown) => {
    const cur = fresh.has(p.name) ? into[p.name] as unknown[] : [];
    fresh.add(p.name);
    into[p.name] = [...cur, ...(Array.isArray(x) ? x : [x])];
  };
  switch (spec.kind) {
    case 'bool': into[p.name] = bool(f.value, flagName, words); break;
    case 'value': into[p.name] = scalar(p.type, v, flagName, words); break;
    case 'file': into[p.name] = await ctx.readText(v); break;
    case 'list': push(scalar(p.type.k === 'strings' ? { k: 'string' } : p.type.of!, v, flagName, words)); break;
    case 'map': {
      const [k, val] = pair(v, flagName, words);
      into[p.name] = { ...(into[p.name] as object), [k]: mapValue(p.type, val) };
      break;
    }
    case 'pairs': {
      const [name, value] = pair(v, flagName, words);
      push({ name, value });
      break;
    }
    case 'objects': {
      const x = parseJson(v, flagName, words);
      if (!x || typeof x !== 'object') throw new UsageError(`${flagName} takes a JSON object (or a list of them)`, words);
      push(x);
      break;
    }
    case 'attach': push(await attachmentFromFile(resolve(ctx.io.cwd, v))); break;
    case 'object': {
      const x = parseJson(v, flagName, words);
      if (!x || typeof x !== 'object' || Array.isArray(x)) throw new UsageError(`${flagName} takes a JSON object, or set fields with --${spec.flag}.<field>`, words);
      into[p.name] = x;
      break;
    }
    default: into[p.name] = jsonish(v);
  }
}

/** --tracking.opens=false, --template.id x, --template.variables.name Ann */
function setField(spec: FlagSpec, path: string, value: string | undefined, into: Record<string, unknown>, words: string[]): void {
  const flagName = `--${spec.flag}.${path}`;
  const input = API.inputs[spec.param.type.ref!];
  const [field, ...rest] = path.split('.');
  const f = input.fields.find((x) => x.name === field || kebab(x.name) === field);
  if (!f) throw new UsageError(`Unknown flag ${flagName}: ${spec.param.name} has ${input.fields.map((x) => x.name).join(', ')}`, words);
  const obj = { ...(into[spec.param.name] as Record<string, unknown>) };
  into[spec.param.name] = obj;
  if (rest.length) {
    if (f.type.k !== 'map') throw new UsageError(`Unknown flag ${flagName}`, words);
    obj[f.name] = { ...(obj[f.name] as object), [rest.join('.')]: mapValue(f.type, value!) };
    return;
  }
  obj[f.name] = f.type.k === 'boolean' ? bool(value, flagName, words) : f.type.k === 'map' || f.type.k === 'any' || f.type.k === 'array' ? parseJson(value!, flagName, words) : scalar(f.type, value!, flagName, words);
}

// ---- printing --------------------------------------------------------------

function print(ctx: Ctx, op: Operation, result: unknown, params: Record<string, unknown>): void {
  if (ctx.json) {
    if (result !== undefined && result !== null) ctx.out(json(result));
    return;
  }
  if (result === undefined || result === null) {
    ctx.out(`${ctx.st.green('Done.')}\n`);
    return;
  }
  if (op.returns?.page) {
    const page = result as { data: Record<string, unknown>[]; has_more: boolean; next_cursor?: string | null };
    ctx.out(table(page.data, ctx.width, ctx.st));
    if (page.has_more) {
      const query: Record<string, unknown> = {};
      for (const q of op.query) if (params[q.name] !== undefined) query[q.name] = params[q.name];
      const next = nextPageQuery(op.paging, query, page);
      const hint = next ? Object.entries(next).filter(([k, v]) => query[k] !== v).map(([k, v]) => `--${kebab(k)} ${String(v)}`).join(' ') : '';
      ctx.io.stderr.write(ctx.errSt.dim(`More results: add --all${hint ? `, or ${hint} for the next page` : ''}.`) + '\n');
    }
    return;
  }
  ctx.out(details(result as Record<string, unknown>, ctx.width, ctx.st));
}
