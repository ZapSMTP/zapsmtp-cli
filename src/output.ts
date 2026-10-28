// Output: JSON for scripts, tables for people.
export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
}

const wrap = (on: string, off: string) => (s: string) => `\x1b[${on}m${s}\x1b[${off}m`;
const plain = (s: string) => s;

export function style(color: boolean): Style {
  return color ? { bold: wrap('1', '22'), dim: wrap('2', '22'), red: wrap('31', '39'), green: wrap('32', '39') } : { bold: plain, dim: plain, red: plain, green: plain };
}

export const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

// columns people look for first, in this order
const PREFERRED = ['id', 'name', 'email', 'address', 'key', 'alias', 'from', 'to', 'subject', 'status', 'last_status', 'reason', 'type',
  'event', 'url', 'domain', 'value', 'permission', 'mode', 'enabled', 'created_at', 'last_message_at', 'date'];
const MAX_COLUMNS = 6;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isScalarish = (v: unknown) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object'));

/** One cell: lists joined, objects as JSON, nothing for null. */
export function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object' || x === null)) return v.map((x) => String(x ?? '')).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).replace(/\s+/g, ' ');
}

const clip = (s: string, w: number) => s.length <= w ? s : s.slice(0, w - 1) + '…';

/** A table of rows, fitted to width; the columns are chosen from the rows' fields. */
export function table(rows: Record<string, unknown>[], width: number, st: Style): string {
  if (!rows.length) return st.dim('(none)') + '\n';
  const keys: string[] = [];
  for (const r of rows) for (const [k, v] of Object.entries(r)) if (!keys.includes(k) && isScalarish(v)) keys.push(k);
  const cols = [...PREFERRED.filter((k) => keys.includes(k)), ...keys.filter((k) => !PREFERRED.includes(k))].slice(0, MAX_COLUMNS);
  const cells = rows.map((r) => cols.map((c) => cell(r[c])));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  // shrink the widest column until the table fits (two spaces between columns)
  const total = () => widths.reduce((a, b) => a + b, 0) + 2 * (cols.length - 1);
  while (total() > width) {
    const i = widths.indexOf(Math.max(...widths));
    if (widths[i] <= 8) break;
    widths[i]--;
  }
  const line = (vals: string[]) => vals.map((v, i) => i === vals.length - 1 ? clip(v, widths[i]) : clip(v, widths[i]).padEnd(widths[i])).join('  ').trimEnd();
  return [st.bold(line(cols.map((c) => c.toUpperCase()))), ...cells.map(line)].join('\n') + '\n';
}

/** An object as name: value lines; lists of objects follow as tables, nested objects one level flattened. */
export function details(obj: Record<string, unknown>, width: number, st: Style): string {
  const pairs: [string, string][] = [];
  const tables: [string, Record<string, unknown>[]][] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length && v.every(isPlainObject)) tables.push([k, v as Record<string, unknown>[]]);
    else if (isPlainObject(v) && Object.keys(v).length && Object.values(v).every(isScalarish)) for (const [k2, v2] of Object.entries(v)) pairs.push([`${k}.${k2}`, cell(v2)]);
    else pairs.push([k, cell(v)]);
  }
  const w = Math.max(0, ...pairs.map(([k]) => k.length));
  let out = pairs.map(([k, v]) => `${st.dim(k.padEnd(w))}  ${clip(v, Math.max(20, width - w - 2))}`).join('\n') + (pairs.length ? '\n' : '');
  for (const [k, rows] of tables) out += `\n${st.bold(k)}\n${table(rows, width, st)}`;
  return out;
}
