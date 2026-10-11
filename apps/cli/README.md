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
hive bot create --name <name> [--instructions <text> | --instructions-file <path|->]
                [--tools <Tool=allow|ask|deny,...>] [--cwd-mode run_scratch|environment] [placement flags]
hive bot update <bot-id> [--instructions <text> | --instructions-file <path|->] [--tools ...] [--cwd-mode ...]
                [placement flags]
  placement flags: [--mode any|preferred|pinned] [--preferred <id,...>] [--allowed <id,...>] [--allowed-device <id>]...
                   [--overflow|--no-overflow] [--fallback|--no-fallback] [--capabilities <name,...>] [--environment <name>]
hive device env add --name <name> --repo <url> --path <local checkout root>
hive approval list [--state pending|approved|denied|expired]   # default pending
hive approval resolve <approval-id> (--allow | --deny) [--reason <text>]
hive approval watch [--timeout <s>]                # prints each new pending approval once, polls every 2 s
hive search <query> [--kinds message,task,memory]   # GET /v1/search; 1-2 characters take the bounded short path
hive memory write --scope <workspace|channel:<id>|project:<id>|bot:<id>|task:<id>> (--content <text> | --file <path|->)
hive memory list --scope <...>                         # live memories of the scope, newest first
hive memory delete <memory-id> [--revision <n>]        # tombstone; a live memory is at revision 1
hive agent send <bot-id> --channel <channel-id> --message <text> [--notify] [--wait [--timeout <s>]]
hive event emit <type> [--data-file <path|->] [--subject <kind:id>]
hive op get <operation-id>
hive run get <run-id>                                  # state, persistence (pending|complete), transcript parts
hive run transcript <run-id> [--raw]                   # normalized, redacted entries; --raw: owner-only JSONL
hive job get <job-id>
hive job watch <job-id> [--timeout <s>]                # polls GET /v1/jobs/:id every 2 s
hive inbox list --bot <bot-id>
hive channel list | hive bot list | hive device list   # bootstrap lists of the workspace
hive channel messages <channel-id>                     # newest-first messages of a member channel
hive bot conversations                                 # private bot-to-bot conversations and their messages
hive sync changes [--cursor <cursor>]                  # without --cursor: the bootstrap cursor
hive executor run [--once] [--provider fake|claude|codex] [--concurrency N]  # Local Executor (default fake, 1)
hive project create --key <KEY> --name <name>
hive task create (--project <KEY> | --parent <task>) --title <title> [--priority <n>]
hive task list [--project <KEY>] [--status <status>]
hive task plan <task> --after <task>...                # adds prerequisites
hive task assign <task> (--bot <bot-id> | --user <user-id> | --none)
hive task complete <task>
hive job start --task <task> --bot <bot-id> [--device <device-id>] [--wait [--timeout <s>]]
hive subscription create --file <path|->           # JSON: the subscription.create fields without "type"
hive subscription list
hive subscription pause <subscription-id>
hive subscription test <subscription-id> [--limit <n>]   # dry-run over recent events
hive integration create --kind github|slack [--external-account-id <id>]   # prints the hook path
hive job cancel <job-id>                           # queued: cancelled now; active: stops at the next lease renewal
hive job resolve <job-id> (--retry | --cancel | --mark-failed)   # a recovery_required Job
hive routine create --bot <bot-id> --name <name> --cron "0 9 * * 1-5" --input <text> [--tz <zone>]
                    [--channel <channel-id>] [--misfire skip|coalesce]
hive routine list
hive routine run <routine-id>                      # manual run: one Job now
hive routine pause <routine-id> | hive routine resume <routine-id>
```

`<task>` is a key (`APP-1`) or an id. The CLI lists the Workspace's Tasks to resolve it and sends the Task's
current revision as `expectedRevision`; a concurrent edit is 409 (exit 4), so rerun the command.

Global options: `--format text|json` (default `text`), `--api-url <url>` (default `apiUrl` from the credentials
file), `--workspace <id>` (default `workspaceId`), `--idempotency-key <key>` and `--operation-id <id>` (default:
a fresh UUID per invocation).

- **Output.** `text` prints one `key: value` line per top-level field (objects as JSON). `json` prints exactly the
  API response, one per line: `agent send --wait` prints the send response, then the Job. Progress (`job state:`)
  and diagnostics go to stderr. On an API error, `json` also prints the `ApiError` body on stdout.
- **`--wait`** polls `GET /v1/operations/:id` until routing created the Job, then watches it. `--notify` creates no
  Job, so `--notify --wait` is invalid. A timeout never cancels the Job. The default timeout is 300 s.
- **`event emit`** reads JSON from `--data-file` (`-` is stdin); without it `data` is `{}`.
- **`routine create`** defaults `--tz` to this machine's IANA zone. `--channel` is resolved to the Channel's main
  Conversation (the Routine's lane and reply target) through `channel list`. `job resolve --retry` is 409 (exit 4)
  until the old Run's stop is confirmed by its executor.
- **`--tools`** is `Read=allow,Bash=ask` (Read, Grep, Glob, Edit, Write, Bash; a missing tool is `deny`).
  `bot update --tools` replaces the tool list and keeps the current `cwdMode` unless `--cwd-mode` is given; it reads
  the Bot's revision from `bot list`, so a concurrent edit is 409 (exit 4). **Security:** Bash is not
  path-restricted (see `apps/executor/README.md`, Tool policy and approvals); prefer `Bash=ask`.
- **Placement flags** build the Bot's `placementPolicy` (`apps/api-worker/README.md`, Placement): `--allowed` and
  `--allowed-device` add up, `--overflow` / `--no-fallback` set `overflowToFallback: true` /
  `fallbackOnUnavailable: false`. `bot update` merges the given fields over the Bot's current policy from `bot list`;
  the server rejects preferred devices outside a non-empty allowed list and a `pinned` mode without exactly one
  `--preferred` (422, exit 2). `device list` shows each device's `capabilities`, `capacityBackground` and
  `lastHeartbeatAt` (online = within 45 s).
- **`device env add`** resolves `--path` to an existing directory and writes it to
  `<config dir>/hive/executor/environments.json` first (the local path never leaves the device), then registers
  `{deviceId (from the stored device token), name, repository}` in the cloud. A Bot created with
  `--environment <name> --cwd-mode environment` then runs in that checkout on devices that registered the name.
- **`search`** and **`memory`** follow `apps/api-worker/README.md`, Search and memory. `search` is the one
  one-word command: the dispatcher tries `<group> <action>`, then `<group>`. `memory delete` defaults `--revision` to
  1 because a memory's content never changes (corrections supersede it); a deleted one is 422 (exit 2).
- **`approval resolve`** is one-use: a second resolve, an expired approval or one whose Run is no longer current is
  409 (exit 4).
- **`subscription create`** sends the file's JSON object as the `subscription.create` command, for example
  `{"botId": "<bot-id>", "eventTypes": ["github.pull_request.*"], "filter": {"op": "eq", "field":
"data.repositoryId", "value": 42}, "destination": {"conversationId": "<conversation-id>"}, "delivery": {"mode":
"batch"}}`. The server validates it (see `apps/api-worker/README.md`, Subscriptions).
- **`executor run`** wraps `runLoop` from `@hive/executor` with the credentials' `deviceToken` and the heartbeat of
  `executorHeartbeat` (capabilities, `--concurrency` as the background capacity); the journal lives in
  `<config dir>/hive/executor/` (Claude transcripts under `transcripts/`, run cwd under `runs/`; see
  `apps/executor/README.md`). `FAKE_DELAY_MS` / `FAKE_FAIL=1` tune the fake provider. Before each poll it calls
  `POST /v1/executor/pump`, because no Queue consumer exists yet and `wrangler dev` fires no cron. After each Run
  (and at start for earlier ones) it uploads the Run's transcript; see `apps/executor/README.md`, Transcript upload.
- **`run transcript`** pages `GET /v1/runs/:id/transcript` until the last confirmed part and prints
  `<seq> <kind>[(<tool>)]: <text>` per entry (`--format json`: `{entries}`). It needs membership of the Run's
  channel or Workspace ownership (404 otherwise). `--raw` prints `GET /v1/transcripts/:id/raw` as-is (owner only).

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
- No `event inspect`, `subscription update / delete / resume`, `task cancel` or `task plan --remove` yet. `job start --wait` watches the
  Job, not the Task; complete the Task with `task complete`.
