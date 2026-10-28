import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeFetch, run, tmp } from './helpers.js';

describe('independent credential storage checks', () => {
  it('keeps a rejected login credential out of stderr even if the API echoes it', async () => {
    const key = 'zap_test_rejected_secret_123456';
    const f = fakeFetch(() => [401, { error: { code: 'invalid_api_key', message: `Invalid API key ${key}` } }]);
    const r = await run(['login'], { stdin: key + '\n', fetch: f.fetch });
    expect(r.code).toBe(1);
    expect(r.out + r.err).not.toContain(key);
  });

  it('does not follow a pre-existing symlink at the predictable temporary config path', async () => {
    const root = tmp();
    try {
      const dir = join(root, 'zapsmtp');
      mkdirSync(dir);
      const victim = join(root, 'unrelated-file');
      writeFileSync(victim, 'keep this content', { mode: 0o644 });
      symlinkSync(victim, join(dir, `config.json.${process.pid}.tmp`));
      const f = fakeFetch(() => [200, { plan: { name: 'Free' } }]);
      await run(['login', '--key', 'zap_test_config_secret'], { env: { XDG_CONFIG_HOME: root }, fetch: f.fetch });
      expect(readFileSync(victim, 'utf8')).toBe('keep this content');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('stores an ordinary login config with mode 0600', async () => {
    const root = tmp();
    try {
      const f = fakeFetch(() => [200, { plan: { name: 'Free' } }]);
      const r = await run(['login', '--key', 'zap_test_config_secret'], { env: { XDG_CONFIG_HOME: root }, fetch: f.fetch });
      expect(r.code, r.err).toBe(0);
      expect(statSync(join(root, 'zapsmtp', 'config.json')).mode & 0o777).toBe(0o600);
      expect(r.out + r.err).not.toContain('zap_test_config_secret');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
