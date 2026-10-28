// Help text, generated from the API model's docs.
import { type Command, flagSpecs, kebab, placeholder } from './commands.js';
import type { Style } from './output.js';
import { VERSION } from './version.js';

export const GLOBAL_HELP = `Global flags:
  --key <key>               API key (default: ZAP_API_KEY, else the saved profile)
  --profile <name>          Saved profile to use (default: ZAP_PROFILE, else "default")
  --base-url <url>          API base URL (default: ZAP_BASE_URL, else the profile's, else https://api.zapsmtp.com/v1)
  --json                    Print JSON (the default when output is not a terminal)
  --output <table|json>     Choose the output format
  --all                     On a list: fetch every page
  --json '<json>'           Parameters as a JSON object (a list for emails send-batch); flags override it
  --json-file <path>        The same, from a file (- for stdin); --data and --data-file are aliases
  --no-color                No colors (also NO_COLOR=1)
  -h, --help                Help for any command`;

/** Hand-written commands, listed before the API's. */
export const HELPERS: [string, string][] = [
  ['login', 'Save an API key (checked first) to a profile'],
  ['logout', 'Remove a saved profile (--all: every profile)'],
  ['whoami', 'Show the key in use, its plan and this month\'s usage'],
  ['send', 'Send an email: the flags of emails send, From defaulting to ZAP_SENDER'],
  ['test [scenario]', 'Send a test email to a simulator address (delivered, bounced, complained...)'],
  ['webhooks verify', 'Check a webhook request\'s Zap-Signature'],
];

/** Wraps text to width, each line indented. */
export function wrapText(text: string, width: number, indent = ''): string {
  const lines: string[] = [];
  for (const para of text.split(/\n+/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && indent.length + line.length + 1 + word.length > width) {
        lines.push(indent + line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(indent + line);
  }
  return lines.join('\n');
}

export function mainHelp(cmds: Command[], st: Style): string {
  const groups = new Map<string, Command[]>();
  for (const c of cmds) groups.set(c.words[0], [...(groups.get(c.words[0]) ?? []), c]);
  const groupLines = [...groups].map(([g, list]) => `  ${g.padEnd(20)}${[...new Set(list.map((c) => c.words.slice(1).join(' ').split(' ')[0]))].join(', ')}`);
  return `${st.bold('zapsmtp')} ${VERSION}: the ZapSMTP command line

${st.bold('Usage')}
  zapsmtp <command> [arguments] [flags]
  zapsmtp <resource...> <method> [ids] [--param value ...]

${st.bold('Examples')}
  zapsmtp login
  zapsmtp send --from you@yourdomain.com --to jane@example.org --subject Hi --html-file body.html
  zapsmtp emails list --limit 5
  zapsmtp templates versions get <id> <version-id>
  zapsmtp domains verify <id>
  zapsmtp test bounced --from you@yourdomain.com

${st.bold('Commands')}
${HELPERS.map(([n, d]) => `  ${n.padEnd(20)}${d}`).join('\n')}

${st.bold('API')} (zapsmtp <resource> --help lists the methods)
${groupLines.join('\n')}

${GLOBAL_HELP}
`;
}

/** The commands under a word path, e.g. every "emails ..." command. */
export function groupHelp(prefix: string[], cmds: Command[], width: number, st: Style): string {
  const list = cmds.filter((c) => prefix.every((w, i) => c.words[i] === w));
  const names = list.map((c) => c.words.slice(prefix.length).join(' ') + c.op.pathParams.map((p) => ` <${kebab(p.name)}>`).join(''));
  const w = Math.min(44, Math.max(...names.map((n) => n.length)) + 2);
  return `${st.bold('Usage')}
  zapsmtp ${prefix.join(' ')} <method> [ids] [flags]

${st.bold('Methods')}
${list.map((c, i) => `  ${names[i].padEnd(w)}${clipLine(c.op.title, width - w - 2)}`).join('\n')}

Run zapsmtp ${prefix.join(' ')} <method> --help for its flags.
`;
}

/** b as the next sentence after a. */
const then = (a: string, b: string): string => !a ? b : `${/[.!?)]$/.test(a) ? a : a + '.'} ${b}`;

const clipLine = (s: string, w: number) => s.length <= w ? s : s.slice(0, Math.max(10, w - 1)) + '…';

export function commandHelp(cmd: Command, width: number, st: Style): string {
  const op = cmd.op;
  const args = op.pathParams.map((p) => `<${kebab(p.name)}>`).join(' ');
  const specs = [...flagSpecs(op).values()];
  const lines: string[] = [];
  for (const s of specs.filter((x) => x.primary)) {
    const aliases = specs.filter((x) => !x.primary && x.param === s.param && x.flag !== s.param.name).map((x) => `--${x.flag}${placeholder(x)}`);
    const head = `  --${s.flag}${placeholder(s)}${s.param.required ? ' (required)' : ''}`;
    let doc = s.param.doc;
    if (s.kind === 'list') doc = then(doc, 'Repeat the flag for several.');
    if (s.kind === 'bool') doc = then(doc, `--no-${s.flag} sets it to false.`);
    if (s.param.default !== undefined) doc = then(doc, `Default: ${s.param.default}.`);
    if (aliases.length) doc = then(doc, `Also: ${aliases.join(', ')}.`);
    lines.push(head, wrapText(doc, width, '      '));
  }
  if (op.bodyArray) lines.push(`  --json '<list>' / --json-file <path> (required)`, wrapText('The emails to send: a JSON list of email objects, as for emails send (up to 100).', width, '      '));
  if (op.idempotent) lines.push('  --idempotency-key <key>', wrapText('Sent as Idempotency-Key: repeating a request with the same key returns the first result (24 hours). Made for you when omitted.', width, '      '));
  if (op.multipart) lines.push('  --file <path>', wrapText('Upload this file instead of fetching a URL.', width, '      '));
  const usage = `zapsmtp ${cmd.words.join(' ')}${args ? ' ' + args : ''}${lines.length ? ' [flags]' : ''}`;
  let out = `${st.bold(op.title)}\n\n${wrapText(op.doc, width)}\n\n${st.bold('Usage')}\n  ${usage}\n  ${st.dim(`${op.httpMethod} ${op.path}`)}\n`;
  if (op.pathParams.length) out += `\n${st.bold('Arguments')}\n${op.pathParams.map((p) => `  <${kebab(p.name)}>  ${p.doc}`.trimEnd()).join('\n')}\n`;
  if (lines.length) out += `\n${st.bold('Flags')}\n${lines.filter(Boolean).join('\n')}\n`;
  if (op.returns?.page) out += `\n${st.dim('Lists return one page; --all fetches every page.')}\n`;
  return out + `\n${GLOBAL_HELP}\n`;
}
