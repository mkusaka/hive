# @hive/cli

The `hive` CLI (docs/architecture.md §23), Phase 1. Every command goes through the cloud API, including
`hive executor run` on the PC you are sitting at. Runs with Bun (`bin: src/main.ts`).

```sh
alias hive='bun apps/cli/src/main.ts'   # from the repo root
```

## Commands

```text
hive workspace create --id <id> --name <name>          # stores apiUrl + workspaceId in the credentials file
hive device register --name <n> --os <os> --agent-version <v>
                                                       # prints the token once, stores it for `executor run`
hive channel create --name <name>
hive bot create --name <name> [--allowed-device <device-id>]...
hive agent send <bot-id> --channel <channel-id> --message <text> [--notify] [--wait [--timeout <s>]]
hive event emit <type> [--data-file <path|->] [--subject <kind:id>]
hive op get <operation-id>
hive job get <job-id>
hive job watch <job-id> [--timeout <s>]                # polls GET /v1/jobs/:id every 2 s
hive inbox list --bot <bot-id>
hive channel list | hive bot list | hive device list   # bootstrap lists of the workspace
hive sync changes [--cursor <cursor>]                  # without --cursor: the bootstrap cursor
hive executor run [--once]                             # Local Executor (fake provider) with the stored token
```

Global options: `--format text|json` (default `text`), `--api-url <url>` (default `apiUrl` from the credentials
file), `--workspace <id>` (default `workspaceId`), `--idempotency-key <key>` and `--operation-id <id>` (default:
a fresh UUID per invocation).

- **Output.** `text` prints one `key: value` line per top-level field (objects as JSON). `json` prints exactly the
  API response, one per line: `agent send --wait` prints the send response, then the Job. Progress (`job state:`)
  and diagnostics go to stderr. On an API error, `json` also prints the `ApiError` body on stdout.
- **`--wait`** polls `GET /v1/operations/:id` until routing created the Job, then watches it. `--notify` creates no
  Job, so `--notify --wait` is invalid. A timeout never cancels the Job. The default timeout is 300 s.
- **`event emit`** reads JSON from `--data-file` (`-` is stdin); without it `data` is `{}`.
- **`executor run`** wraps `runLoop` from `@hive/executor` with the credentials' `deviceToken`; the journal lives in
  `<config dir>/hive/executor/`. `FAKE_DELAY_MS` / `FAKE_FAIL=1` tune the fake provider. Before each poll it calls
  `POST /v1/executor/pump`, because no Queue consumer exists yet and `wrangler dev` fires no cron.

## Credentials

`$XDG_CONFIG_HOME/hive/credentials.json`, else `~/.config/hive/credentials.json` (directory 0700, file 0600):

```json
{
  "apiUrl": "https://api.example.com",
  "accessJwt": "<optional>",
  "deviceToken": "<optional>",
  "workspaceId": "ws"
}
```

- **Access assertion.** Sent as `Cf-Access-Jwt-Assertion`. `HIVE_ACCESS_JWT` overrides `accessJwt`. In production
  get it with `cloudflared access login <api url>` and `cloudflared access token -app <api url>` (Managed OAuth
  login, gate G-02, is not implemented). Locally use `apps/api-worker/scripts/dev-token.ts`.
- **Device token.** `device register` also writes it alone to `<config dir>/hive/device-token`, the
  `--token-file` of the standalone executor (`apps/executor/src/main.ts`).

## Exit codes (§23)

| Code | Meaning                                                             |
| ---- | ------------------------------------------------------------------- |
| 0    | Accepted, or the waited-for Job succeeded                           |
| 2    | Invalid input: bad arguments, or 422 `INVALID_INPUT`                |
| 3    | Auth / permission: 401 / 403, or no Access assertion / device token |
| 4    | Conflict: 409 (`IDEMPOTENCY_CONFLICT`, `REVISION_CONFLICT`, ...)    |
| 5    | Watched Job `failed` or `cancelled`                                 |
| 6    | Wait timeout (also while a Job sits in `recovery_required`)         |
| 7    | Network failure or not accepted (404, 410, 429, 5xx)                |
| 8    | Reserved for `queued_local` (offline queue); not implemented        |

## Modules

- `src/client.ts`: `fetch` wrapper (injectable `fetch`, base URL, Access header); API errors become `CliError`
  with `code` and `exitCode`. Web-standard APIs only.
- `src/commands.ts`: command bodies, `watchJob`, `waitForOperationJob`. Web-standard APIs only, so
  `apps/api-worker/test/cli.test.ts` runs them in workerd.
- `src/cli.ts`: `node:util` `parseArgs` dispatcher; I/O is injected. `src/main.ts`: real files, stdin, executor.

## Tests

`test/cli.test.ts` (Node): argv → request bodies, stdin data, exit codes, `job watch`, output formats. The
end-to-end loop is `apps/api-worker/test/cli.test.ts`.

## Known gaps

- No OAuth login (`hive login`): the Access assertion is pasted or minted (G-02 not executed).
- No local operation store: after a network timeout, query `hive op get <id>` and resend with the same
  `--operation-id` / `--idempotency-key` by hand.
- No offline queue (`--offline-queue`, exit 8).
- No installed `hive` binary on PATH yet: run it through Bun (alias above).
- Only the Phase 1 commands above; no `job start`, `event inspect`, `task`, `subscription`.
