// Every API operation as a command, run against the conformance mock
// (sdks/conformance/server.mjs), which checks the exact request. The flags
// are written from each case's parameters by their types, the way a person
// would type them.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API } from '../src/generated/api.js';
import type { Param } from '../src/generated/model.js';
import { commands, flagSpecs, kebab } from '../src/commands.js';
import { cases, conformance, KEY, run, tmp } from './helpers.js';

let baseUrl: string;
let stop: () => void;
beforeAll(async () => ({ baseUrl, stop } = await conformance()));
afterAll(() => stop?.());

/** The flags that set a parameter to a value. */
function flagsFor(p: Param, value: unknown, specs: ReturnType<typeof flagSpecs>): string[] {
  const flag = `--${kebab(p.name)}`;
  const spec = specs.get(kebab(p.name))!;
  switch (spec.kind) {
    case 'bool': return value ? [flag] : [`--no-${kebab(p.name)}`];
    case 'list': return (value as unknown[]).flatMap((v) => [flag, String(v)]);
    case 'map': return Object.entries(value as object).flatMap(([k, v]) => [flag, `${k}=${typeof v === 'string' && p.type.of!.k === 'string' ? v : JSON.stringify(v)}`]);
    case 'pairs': return (value as { name: string; value: string }[]).flatMap((t) => [flag, `${t.name}=${t.value}`]);
    case 'objects': return (value as unknown[]).flatMap((v) => [flag, JSON.stringify(v)]);
    case 'object': case 'json': return [flag, JSON.stringify(value)];
    default: return [flag, String(value)];
  }
}

describe('conformance', () => {
  it('has a command for every operation', () => {
    const words = commands().map((c) => c.words.join(' '));
    expect(new Set(words).size).toBe(API.operations.length);
    expect(cases.length).toBe(API.operations.length);
  });

  for (const c of cases) {
    const cmd = commands().find((x) => x.op.id === c.id)!;
    it(`zapsmtp ${cmd.words.join(' ')} (${c.id})`, async () => {
      const argv = [...cmd.words, ...c.call.pathArgs];
      const specs = flagSpecs(cmd.op);
      if (c.call.items) {
        const file = join(tmp(), 'emails.json');
        writeFileSync(file, JSON.stringify(c.call.items));
        argv.push('--json-file', file, '--validation', c.call.options.validation);
      } else {
        for (const p of [...cmd.op.query, ...cmd.op.body]) if (c.call.params?.[p.name] !== undefined) argv.push(...flagsFor(p, c.call.params[p.name], specs));
      }
      const r = await run(argv, { env: { ZAP_API_KEY: KEY, ZAP_BASE_URL: baseUrl } });
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      if (c.response.body === null) expect(r.out).toBe('');
      else if (cmd.op.returns?.page) expect(r.json().data).toEqual(c.response.body.data);
      else expect(r.json()).toEqual(c.response.body);
    });
  }
});
