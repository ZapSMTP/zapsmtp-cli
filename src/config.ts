// Saved API keys: profiles in $XDG_CONFIG_HOME/zapsmtp/config.json (default
// ~/.config/zapsmtp/config.json), readable by the owner only (0600).
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Profile {
  api_key: string;
  base_url?: string;
}

export interface Config {
  profiles: Record<string, Profile>;
}

export function configPath(env: Record<string, string | undefined>): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'zapsmtp', 'config.json');
}

/** The saved config; empty when there is none. A config others can read gets a warning. */
export function readConfig(path: string, warn: (msg: string) => void, platform: string = process.platform): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { profiles: {} };
  }
  if (platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) warn(`${path} can be read by other users: run chmod 600 ${path}`);
  try {
    const c = JSON.parse(text) as Config;
    return { profiles: c && typeof c.profiles === 'object' && c.profiles ? c.profiles : {} };
  } catch {
    throw new Error(`${path} is not valid JSON: fix it or remove it and run zapsmtp login`);
  }
}

/** Writes the config atomically, readable by the owner only. */
export function writeConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // a fresh name, created exclusively: never through a link someone left in the directory
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(tmp, 0o600); // whatever the umask
  renameSync(tmp, path);
}
