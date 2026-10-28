// Flag values: booleans, numbers, key=value pairs and JSON.
import type { Type } from './generated/model.js';
import { UsageError } from './args.js';

export function bool(v: string | undefined, flagName: string, words: string[]): boolean {
  if (v === undefined) return true;
  const s = v.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  throw new UsageError(`${flagName} is true or false, not ${v}`, words);
}

export function scalar(t: Type, v: string, flagName: string, words: string[]): unknown {
  if (t.k === 'integer') {
    if (!/^-?\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new UsageError(`${flagName} takes a whole number, not ${v}`, words);
    return Number(v);
  }
  if (t.k === 'number') {
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n)) throw new UsageError(`${flagName} takes a number, not ${v}`, words);
    return n;
  }
  return v;
}

export function pair(v: string, flagName: string, words: string[]): [string, string] {
  const i = v.indexOf('=');
  if (i <= 0) throw new UsageError(`${flagName} takes key=value, not ${v}`, words);
  return [v.slice(0, i), v.slice(i + 1)];
}

export function parseJson(v: string, flagName: string, words: string[]): unknown {
  try { return JSON.parse(v); } catch { throw new UsageError(`${flagName} is not valid JSON: ${v}`, words); }
}

/** JSON when it parses (42, true, {"a": 1}), else the text itself. */
export function jsonish(v: string): unknown {
  try { return JSON.parse(v); } catch { return v; }
}

/** A map value: text for a map of strings, else JSON when it parses. */
export const mapValue = (t: Type, v: string): unknown => t.of!.k === 'string' ? v : jsonish(v);
