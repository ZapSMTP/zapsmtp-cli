import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { main, type IO } from '../src/main.js';

const dir = fileURLToPath(new URL('../../conformance/', import.meta.url));
export const cases: any[] = JSON.parse(readFileSync(dir + 'cases.json', 'utf8'));
export const vectors: any[] = JSON.parse(readFileSync(new URL('../../spec/webhook-vectors.json', import.meta.url), 'utf8')).vectors;
export const KEY = 'zap_test_conformance';

export async function conformance(): Promise<{ baseUrl: string; stop: () => void }> {
  const server: ChildProcess = spawn(process.execPath, [dir + 'server.mjs', '0']);
  const port = await new Promise<number>((resolve, reject) => {
    server.stdout!.on('data', (d) => {
      const m = /listening (\d+)/.exec(String(d));
      if (m) resolve(Number(m[1]));
    });
    server.on('exit', reject);
  });
  return { baseUrl: `http://127.0.0.1:${port}/v1`, stop: () => server.kill() };
}

export const tmp = (): string => mkdtempSync(join(tmpdir(), 'zapsmtp-cli-'));

export interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
}

/** A fetch answering [status, body, headers?] from a function, recording every request. */
export function fakeFetch(answer: (r: Recorded) => [number, unknown, Record<string, string>?]) {
  const requests: Recorded[] = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: any;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body instanceof FormData) body = init.body;
    const r: Recorded = { method: init.method ?? 'GET', url: new URL(String(input)), headers, body };
    requests.push(r);
    const [status, b, h = {}] = answer(r);
    return new Response(b === undefined ? null : JSON.stringify(b), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'req_fake', ...h } });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  tty?: boolean;
  errTty?: boolean;
  /** stdin text; on a terminal, a list is typed chunk by chunk */
  stdin?: string | string[];
  stdinTty?: boolean;
  fetch?: typeof fetch;
  cwd?: string;
  columns?: number;
}

export interface RunResult {
  code: number;
  out: string;
  err: string;
  json: () => any;
  rawModes: boolean[];
}

/** Runs the CLI in-process. HOME and XDG_CONFIG_HOME point at a fresh directory, and NO_COLOR is set, unless env says otherwise. */
export async function run(argv: string[], o: RunOptions = {}): Promise<RunResult> {
  const stdout = Object.assign(new PassThrough(), { isTTY: o.tty ?? false, columns: o.columns });
  const stderr = Object.assign(new PassThrough(), { isTTY: o.errTty ?? false });
  const rawModes: boolean[] = [];
  const stdin = Object.assign(new PassThrough(), { isTTY: o.stdinTty ?? false, setRawMode: (on: boolean) => { rawModes.push(on); return stdin; } });
  let out = '';
  let err = '';
  stdout.on('data', (d) => { out += d; });
  stderr.on('data', (d) => { err += d; });
  if (o.stdin !== undefined) {
    const chunks = [o.stdin].flat();
    if (o.stdinTty) chunks.forEach((c, i) => setTimeout(() => stdin.write(c), 10 * (i + 1)));
    else stdin.end(chunks.join(''));
  } else if (!o.stdinTty) stdin.end();
  const home = tmp();
  const io: IO = { stdout, stderr, stdin, env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), NO_COLOR: '1', ...o.env }, cwd: o.cwd ?? process.cwd(), fetch: o.fetch };
  const code = await main(argv, io);
  return { code, out, err, json: () => JSON.parse(out), rawModes };
}
