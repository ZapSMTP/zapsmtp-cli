// Command-line parsing: global flags, the command's words, its positional
// arguments and its flags. Flags take their value as --name value or
// --name=value; booleans take none (--name, --name=false, --no-name).

export class UsageError extends Error {
  constructor(message: string, readonly command: string[] = []) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Global flags; true marks one that takes a value. */
export const GLOBAL_FLAGS: Record<string, boolean> = {
  key: true, profile: true, 'base-url': true, output: true, 'json-file': true, data: true, 'data-file': true,
  'idempotency-key': true, all: false, help: false, version: false, 'no-color': false, json: false,
};

export interface RawFlag {
  name: string;
  /** undefined for a flag given without a value */
  value: string | undefined;
}

export interface ParsedArgs {
  positionals: string[];
  flags: RawFlag[];
}

/**
 * The words before the first flag that is not global: where the command is.
 * Global flags (and their values) may come before it.
 */
export function leadingWords(argv: string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    if (!a.startsWith('-') || a === '-') { words.push(a); continue; }
    const name = a.replace(/^--?/, '').split('=')[0];
    if (name === 'h') continue;
    if (!(name in GLOBAL_FLAGS)) break;
    if (!a.includes('=') && (GLOBAL_FLAGS[name] || (name === 'json' && isJsonText(argv[i + 1])))) i++;
  }
  return words;
}

/** Whether a token is a JSON object or list given to --json (rather than the next argument). */
export const isJsonText = (s: string | undefined): boolean => s !== undefined && /^\s*[[{]/.test(s);

/**
 * Splits argv into positionals and flags. takesValue says whether a flag
 * (not global) reads a value; it throws UsageError for a flag it does not know.
 */
export function parse(argv: string[], takesValue: (name: string) => boolean): ParsedArgs {
  const out: ParsedArgs = { positionals: [], flags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.positionals.push(...argv.slice(i + 1)); break; }
    if (a === '-h') { out.flags.push({ name: 'help', value: undefined }); continue; }
    if (!a.startsWith('--')) {
      if (a.startsWith('-') && a !== '-' && !/^-\d/.test(a)) throw new UsageError(`Unknown flag ${a}`);
      out.positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (!name) throw new UsageError(`Bad flag ${a}`);
    if (eq >= 0) {
      if (!(name in GLOBAL_FLAGS)) takesValue(name); // throws for a flag the command does not have
      out.flags.push({ name, value: a.slice(eq + 1) });
      continue;
    }
    const wants = name in GLOBAL_FLAGS ? GLOBAL_FLAGS[name] || (name === 'json' && isJsonText(argv[i + 1])) : takesValue(name);
    if (!wants) { out.flags.push({ name, value: undefined }); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    out.flags.push({ name, value: next });
    i++;
  }
  return out;
}
