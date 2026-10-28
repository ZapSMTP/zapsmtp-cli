// Commands from the API model: one per operation, named by its SDK resource
// path and method in kebab-case (zapsmtp emails receiving list), with a flag
// per parameter whose syntax follows the parameter's type.
import { API } from './generated/api.js';
import type { Api, Operation, Param, Type } from './generated/model.js';

export const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();

export interface Command {
  /** the words after zapsmtp, e.g. ["emails", "receiving", "list"] */
  words: string[];
  op: Operation;
}

export function commands(api: Api = API): Command[] {
  return api.operations.map((op) => ({ words: [...op.resource, op.method].map(kebab), op }));
}

/**
 * How a flag sets its parameter:
 *  value   one value (repeating the flag replaces it)
 *  file    the contents of a file (- for stdin) as a string parameter: --html-file body.html
 *  bool    --flag, --flag=false, --no-flag
 *  list    repeat the flag for each item: --to a --to b
 *  map     key=value, repeatable: --metadata order=42
 *  pairs   a list of {name, value} written name=value: --tag plan=pro
 *  objects a list of objects, each JSON (or a JSON list): --variable-schema '{"name": "x", "type": "string"}'
 *  attach  a file attached by path: --attach ./invoice.pdf
 *  object  an object as JSON, or field by field with dots: --tracking.opens=false
 *  json    any JSON value; text that is not JSON is a string
 */
export type FlagKind = 'value' | 'file' | 'bool' | 'list' | 'map' | 'pairs' | 'objects' | 'attach' | 'object' | 'json';

export interface FlagSpec {
  /** the canonical flag name, kebab-case */
  flag: string;
  param: Param;
  kind: FlagKind;
  /** false for an alias, which help does not list on its own line */
  primary: boolean;
}

/** String parameters long enough to come from a file: --html-file body.html */
const FILE_PARAMS = /^(html|text|subject)$|_(svg|pem)$/;
const singular = (s: string): string => s.endsWith('ss') || !s.endsWith('s') ? s : s.slice(0, -1);
const isPairs = (t: Type, api: Api) => t.k === 'array' && t.of?.k === 'ref' &&
  api.inputs[t.of.ref!]?.fields.map((f) => f.name).join(',') === 'name,value';

/** The flags of an operation's query and body parameters, by every name they answer to. */
export function flagSpecs(op: Operation, api: Api = API): Map<string, FlagSpec> {
  const specs = new Map<string, FlagSpec>();
  const params = [...op.query, ...op.body, ...op.options];
  const taken = new Set(params.map((p) => kebab(p.name)));
  const add = (name: string, param: Param, kind: FlagKind, primary = true) => {
    const spec = { flag: name, param, kind, primary };
    specs.set(name, spec);
    if (kebab(param.name) === name && param.name !== name) specs.set(param.name, { ...spec, flag: param.name, primary: false }); // snake_case too
  };
  const alias = (name: string, param: Param, kind: FlagKind) => {
    if (!taken.has(name) && !specs.has(name)) add(name, param, kind, false);
  };
  for (const p of params) {
    const name = kebab(p.name);
    const t = p.type;
    switch (t.k) {
      case 'string': case 'datetime': case 'integer': case 'number':
        add(name, p, 'value');
        if (t.k === 'string' && FILE_PARAMS.test(p.name)) alias(`${name}-file`, p, 'file');
        break;
      case 'boolean': add(name, p, 'bool'); break;
      case 'strings': add(name, p, 'list'); break;
      case 'map': add(name, p, 'map'); alias(singular(name), p, 'map'); break;
      case 'ref': add(name, p, 'object'); break;
      case 'array': {
        const kind: FlagKind = t.of!.k !== 'ref' ? 'list' : isPairs(t, api) ? 'pairs' : 'objects';
        add(name, p, kind);
        alias(singular(name), p, kind);
        if (t.of!.ref === 'OutgoingAttachment') alias('attach', p, 'attach');
        break;
      }
      default: add(name, p, 'json');
    }
  }
  return specs;
}

/** The placeholder help shows after a flag. */
export function placeholder(spec: FlagSpec): string {
  const t = spec.param.type;
  switch (spec.kind) {
    case 'bool': return '';
    case 'file': case 'attach': return ' <path>';
    case 'map': return ' <key=value>';
    case 'pairs': return ' <name=value>';
    case 'objects': case 'object': case 'json': return ' <json>';
    case 'list': return t.k === 'strings' ? ' <address>' : ' <value>';
    default: return spec.param.enum ? ` <${spec.param.enum.join('|')}>` : t.k === 'integer' || t.k === 'number' ? ' <n>' : ' <value>';
  }
}
