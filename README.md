# ZapSMTP CLI

The official command line for [ZapSMTP](https://zapsmtp.com): send, receive and track email, and
manage templates, domains, webhooks and everything else the API does, from your terminal or a script.

- **The whole API**: a command for every API operation (112), generated from the API reference, with
  `--help` for each.
- **Typed flags**: `--to a --to b`, `--tag plan=pro`, `--metadata order=42`, `--attach ./invoice.pdf`,
  `--html-file body.html`, `--tracking.opens=false`, or the whole body as `--json '{...}'`.
- **Tables for people, JSON for scripts**, `--all` to walk every page, and exit codes you can test.
- **Saved profiles** for your keys, readable by you only.
- Safe retries: sends carry an idempotency key, so a retry never sends twice.

Node.js 18.3 or newer. Built on the official [Node.js SDK](https://www.npmjs.com/package/zapsmtp).

## Install

```bash
npm install -g zapsmtp-cli
zapsmtp --help
```

or without installing:

```bash
npx zapsmtp-cli emails list
```

## Log in

```bash
zapsmtp login                    # asks for the key (not echoed), checks it, saves it
zapsmtp whoami                   # which key, its plan and this month's usage
```

`login` checks the key with the API before saving it to `~/.config/zapsmtp/config.json` (or
`$XDG_CONFIG_HOME/zapsmtp/config.json`), which only you can read (`0600`). A key the API refuses is
never saved. In scripts, pipe the key in: `printenv ZAP_KEY | zapsmtp login`.

Profiles keep several keys apart:

```bash
zapsmtp login --profile staging --base-url https://staging.example/v1
zapsmtp emails list --profile staging        # or ZAP_PROFILE=staging
zapsmtp logout --profile staging             # zapsmtp logout --all removes every profile
```

The key used is the first of: `--key`, `ZAP_API_KEY`, the profile (`--profile`, `ZAP_PROFILE`, else
`default`). The base URL: `--base-url`, `ZAP_BASE_URL`, the profile's, else `https://api.zapsmtp.com/v1`.

## Send

```bash
zapsmtp send --from "Acme <hello@acme.com>" --to jane@example.org \
  --subject "Your receipt" --html-file receipt.html \
  --tag category=receipt --metadata order_id=A-1042 --attach ./invoice.pdf
```

`zapsmtp send` is `zapsmtp emails send` with `--from` defaulting to `ZAP_SENDER`. With a template:

```bash
zapsmtp send --to jane@example.org --template.id welcome --template.variables.name Jane
```

Try every delivery outcome without sending anything anywhere, on the simulator:

```bash
export ZAP_SENDER=hello@acme.com   # or pass --from
zapsmtp test                       # delivered
zapsmtp test bounced
zapsmtp test bounce+421+4.7.0+try-later
```

## Commands

```
zapsmtp <resource...> <method> [ids] [--param value ...]
```

Every API operation is a command named after the [Node.js SDK](https://www.npmjs.com/package/zapsmtp)
method in kebab-case: `zap.emails.receiving.list` is `zapsmtp emails receiving list`, and
`zap.templates.versions.get(id, vid)` is `zapsmtp templates versions get <id> <vid>`.
`zapsmtp <resource> --help` lists a resource's methods; `zapsmtp <resource> <method> --help` its flags.

| Commands | |
|---|---|
| `login`, `logout`, `whoami` | Saved keys |
| `send`, `test` | Send an email; send to the simulator |
| `webhooks verify` | Check a webhook request's signature |
| `emails` | `send`, `send-batch`, `list`, `get`, `update` (reschedule), `cancel`, `get-content`, `spam-check`, `spam-check-sent`, `share`, `attachments list/get` |
| `emails receiving` | `list`, `get`, `delete`, `reply`, `report-spam`, `redeliver`, `attachments list/get` |
| `threads` | `list`, `get`, `update` |
| `templates` | `list`, `create`, `get`, `update`, `delete`, `render`, `render-source`, `publish`, `duplicate`, `versions list/get/restore` |
| `variables` | `list`, `set-global`, `delete-global` |
| `template-modules`, `template-assets`, `template-timers` | Modules, hosted images (`upload --file logo.png`), countdown timers |
| `domains` | `list`, `create`, `get`, `update`, `verify`, `delete`, `get-dmarc`, `get-reputation`, `check-reputation`, `get-brand`, `update-brand` |
| `webhooks` | `list`, `create`, `get`, `update`, `delete`, `test`, `list-deliveries`, `rotate-secret`, `events list/get/replay` |
| `actions` | Click actions: `list`, `create`, `get`, `update`, `delete` |
| `inbound` | `get-stats`, `domains ...`, `routes ...`, `forward-destinations ...` |
| `suppressions` | `list`, `get`, `create`, `delete`, `create-batch`, `delete-batch` |
| `stats` | `get`, `timeseries`, `breakdown`, `metrics` |
| `logs`, `usage`, `simulator`, `dedicated-ips` | API logs, usage and plan, simulator addresses, dedicated IPs |
| `api-keys`, `smtp-credentials` | Keys and SMTP relay credentials |

## Flags

Parameters are flags in kebab-case (`--reply-to`, `--scheduled-at`; the API's `reply_to` works too).
How a flag takes its value follows the parameter's type:

| Parameter | Flag | Example |
|---|---|---|
| text, number | `--name value` or `--name=value` | `--limit 5`, `--subject "Hi there"` |
| long text | `--name-file <path>` (`-` reads stdin) | `--html-file body.html`, `--logo-svg-file logo.svg` |
| true/false | `--name`, `--name=false`, `--no-name` | `--publish`, `--no-enabled` |
| list | repeat the flag | `--to a@x.com --to b@x.com`, `--event email.bounced` |
| key/value map | `--name key=value`, repeatable (singular works too) | `--metadata order=42`, `--header X-Campaign=fall` |
| tags | `--tag name=value` | `--tag plan=pro` |
| attachments | `--attach <path>`, or `--attachment '<json>'` | `--attach ./invoice.pdf` |
| object | `--name '<json>'`, or field by field | `--tracking.opens=false`, `--template.id welcome` |
| anything | `--json '{...}'` or `--json-file <path>` | `--json-file email.json --to jane@example.org` |

Flags are applied on top of `--json`/`--json-file`, so a file can hold the common parts: a flag replaces
the JSON's value (a list flag such as `--to` replaces the whole list), and map flags such as `--metadata`
set their keys. `--key=value` and `--key value` are the same; unknown flags are refused either way. `emails send-batch`
takes its emails as a JSON list: `--json-file emails.json --validation permissive`. Sends take
`--idempotency-key`; one is made for you otherwise.

## Output

- On a terminal: tables for lists, `name  value` lines for one object. When there are more results the
  CLI says how to get them (`--all`, or the flag for the next page) on stderr.
- Piped, or with `--json` (or `--output json`): the API's JSON, pretty-printed. A command without an
  answer body prints nothing.
- `--all` fetches every page of a list (`zapsmtp suppressions list --all --json > suppressions.json`).
- Colors only on a terminal; `NO_COLOR=1` or `--no-color` turns them off.

`--json` with a JSON value right after it (`--json '{"to": "a@x.com"}'`) is the request body; on its
own it asks for JSON output.

## Exit codes

| Code | |
|---|---|
| `0` | Done |
| `1` | The API answered with an error (stderr shows its message, status, code and request id), the request could not be sent, or `webhooks verify` found the signature wrong |
| `2` | Usage: an unknown command or flag, a missing argument, a malformed value, no API key |

```
$ zapsmtp emails get 019a0000-0000-7000-8000-000000000000
Error: Email not found
  status 404 · code not_found · request id req_8f2c...
```

## Webhooks

```bash
export ZAP_WEBHOOK_SECRET=whsec_...
zapsmtp webhooks verify --signature 't=1767225600,v1=5d3f...' --payload-file body.json
```

Checks `Zap-Signature` against the raw body (exactly as received) and prints the event, or exits `1`.
`--tolerance <seconds>` (default 300) and `--now <unix seconds>` check a recorded request.

## Environment

| Variable | |
|---|---|
| `ZAP_API_KEY` | API key (after `--key`, before the saved profile) |
| `ZAP_PROFILE` | Saved profile to use |
| `ZAP_BASE_URL` | API base URL |
| `ZAP_SENDER` | From for `send`, `test`, `emails send` and `emails send-batch` when they omit it |
| `ZAP_WEBHOOK_SECRET` | Secret for `webhooks verify` |
| `NO_COLOR` | No colors |
| `XDG_CONFIG_HOME` | Where the config directory lives (default `~/.config`) |

## Development

```bash
cd sdks/node && npm ci && npm run build   # the SDK this package uses
cd ../cli && npm ci
npm run generate    # src/generated/ by sdks/codegen (emit/cli.mjs); the build fails when it is stale
npm test            # every command against the conformance server, help, output, exit codes, login
npm run coverage    # 100% of the hand-written code
npm run build
../live/run.sh cli  # against the dev API
```
