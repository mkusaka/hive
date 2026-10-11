# @hive/cli

The `hive` CLI (docs/architecture.md §23), Phase 1. Every command goes through the cloud API, including
`hive executor run` on the PC you are sitting at. Runs with Bun (`bin: src/main.ts`).

```sh
alias hive='bun apps/cli/src/main.ts'   # from the repo root
```

## Commands

```text
hive workspace create --id <id> --name <name>          # stores apiUrl + workspaceId in the credentials file
hive login                                             # Access Managed OAuth in the system browser
hive logout                                            # forgets the stored OAuth grant
hive device register --name <n> --os <os> --agent-version <v>
                     [--access-client-id <id> --access-client-secret-file <path|->]
                                                       # prints the token once, stores it for `executor run`
hive channel create --name <name>
hive channel update <channel-id> --topic <text>     # members only; "" clears it
hive channel join <channel-id> --bot <bot-id>       # add a Bot member (members only); channel leave removes it
hive dm open <bot-id>                                 # {conversationId} of your DM with the Bot (created once)
hive dm list                                          # your DMs with botId, name, lastMessage
hive bot create --name <name> [--instructions <text> | --instructions-file <path|->]
                [--tools <Tool=allow|ask|deny,...>] [--effects <slack.post|github.comment=allow|ask|deny,...>]
                [--cwd-mode run_scratch|environment] [placement flags]
hive bot update <bot-id> [--instructions <text> | --instructions-file <path|->] [--tools ...] [--effects ...]
                [--cwd-mode ...] [placement flags]
  placement flags: [--mode any|preferred|pinned] [--preferred <id,...>] [--allowed <id,...>] [--allowed-device <id>]...
                   [--overflow|--no-overflow] [--fallback|--no-fallback] [--capabilities <name,...>] [--environment <name>]
hive device env add --name <name> --repo <url> --path <local checkout root>
hive approval list [--state pending|approved|denied|expired]   # default pending
hive approval resolve <approval-id> (--allow | --deny) [--reason <text>]
hive approval watch [--timeout <s>]                # prints each new pending approval once, polls every 2 s
hive effect list [--state <state>] [--run <run-id>]  # external effects, newest first
hive effect resolve <effect-id> (--succeeded <external-id> [--url <url>] | --failed | --retry)
hive audit list [--kind <kind,...>] [--since <ISO>] [--cursor <cursor>] [--actor <actor-id>]
hive status                                           # sync, outbox, search, Jobs, effects, devices, and routines
hive search <query> [--kinds message,task,memory]   # GET /v1/search; 1-2 characters take the bounded short path
hive memory write --scope <workspace|channel:<id>|project:<id>|bot:<id>|task:<id>> (--content <text> | --file <path|->)
hive memory list --scope <...>                         # live memories of the scope, newest first
hive memory delete <memory-id> [--revision <n>]        # tombstone; a live memory is at revision 1
hive agent send <bot-id> --channel <channel-id> --message <text> [--notify] [--wait [--timeout <s>]]
hive message post (--channel <channel-id> | --conversation <dm-id>) [--thread-of <message-id>] --text <text> [--resolve-names]  # <@bot:ID> wakes that Bot (a DM always wakes its Bot); --thread-of replies in that message's thread (Bots already in it wake too); --resolve-names maps @name
hive thread list                                      # threads you started or replied in, newest reply first
hive event emit <type> [--data-file <path|->] [--subject <kind:id>]
hive op get <operation-id>
hive run get <run-id>                                  # state, persistence (pending|complete), transcript parts, git
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
hive task get <task>                                   # Task, results, Jobs, delegations, git rollup (commits, PRs, repositories)
hive task plan <task> --after <task>...                # adds prerequisites
hive task assign <task> (--bot <bot-id> | --user <user-id> | --none)
hive task complete <task>
hive task delegate <task> --to <bot-id> --mode <read|write> --instructions <text> [--deadline <iso-timestamp>]
hive task delegations <task>                           # the Task's delegations (also in task get)
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
hive routine delete <routine-id>                   # the Routine and its occurrences; its Jobs stay
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
- **`effect resolve`** is manual recovery of an `unknown` effect (`--succeeded` / `--failed`) or a re-send of an
  `unknown` or performed `failed` one (`--retry`); see `apps/api-worker/README.md`, External effects. `--tools` and
  `--effects` each replace their own list on `bot update`; the other is kept.
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

## Run as a service (macOS)

```sh
hive executor install --provider claude [--concurrency N]   # writes and loads the launchd agent, prints captured env names
hive executor status                                        # loaded, state, pid, last exit code, installed, provider, concurrency, program, plist and log paths
hive executor uninstall                                     # bootout + removes the plist; logs and credentials stay
```

- `install` writes `~/Library/LaunchAgents/com.hive.executor.plist` (0600) running
  `<bun> apps/cli/src/main.ts executor run --provider P --concurrency N` with `RunAtLoad` and `KeepAlive`, working
  directory `<config dir>/hive`, logs in `<config dir>/hive/executor/logs/{stdout,stderr}.log`, then
  `launchctl bootout` (if loaded) and `launchctl bootstrap gui/<uid>`. Rerun it to change flags or after moving the
  checkout or Bun (paths are absolute). It needs `apiUrl` and `deviceToken` in the credentials file.
- Environment: only `PATH`, `HOME`, and, when set in the installing shell, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`,
  `CLAUDE_CODE_OAUTH_TOKEN` are copied into the plist (names are printed, values never). A store-backed Claude
  resume needs a login the SDK can copy: `CLAUDE_CODE_OAUTH_TOKEN`, or `.credentials.json` in `CLAUDE_CONFIG_DIR`;
  the keychain login works only with `CLAUDE_CONFIG_DIR` unset.
- Stop: on SIGTERM (`launchctl bootout`, `launchctl kill SIGTERM`, logout) the executor stops polling, stops its
  running agents (their Runs get no result, so the restarted executor resumes them through reconcile) and exits
  within 10 s. `KeepAlive` restarts it after any
  exit except `uninstall`.
- `status` also reads the plist's `ProgramArguments` (never its environment values): `installed`, `provider`,
  `concurrency` and the full `program` argv.
- The desktop app owns the same agent and reinstalls it with its own program (Electron in headless executor mode)
  on every start; after `hive executor install` the next app start replaces the CLI program, keeping provider and
  concurrency (`apps/desktop/README.md`, Executor service).
- Logs: `executor run` rotates `stdout.log` / `stderr.log` at start and every hour. A file over 5 MiB is copied to
  `.1` (older copies shift to `.2`, `.3`; a fourth is dropped) and truncated in place, because launchd keeps it open
  in append mode; lines written between the copy and the truncate are lost. Local Run data retention:
  `apps/executor/README.md`, Local retention.
- Other platforms: the three commands exit 2 with "not supported yet".

## Credentials

`$XDG_CONFIG_HOME/hive/credentials.json`, else `~/.config/hive/credentials.json` (directory 0700, file 0600):

```json
{
  "apiUrl": "https://api.example.com",
  "accessJwt": "<optional, local dev>",
  "oauth": "<optional, written by hive login>",
  "deviceToken": "<optional>",
  "accessClientId": "<optional>",
  "accessClientSecret": "<optional>",
  "workspaceId": "ws"
}
```

- **User auth, in this order.** `HIVE_ACCESS_JWT`, else `accessJwt`, is sent as `Cf-Access-Jwt-Assertion`
  straight to `wrangler dev` (mint it with `apps/api-worker/scripts/dev-token.ts`). Else the stored OAuth grant
  from `hive login` is sent as `Authorization: Bearer <access token>`; Cloudflare Access resolves it and forwards
  the same `Cf-Access-Jwt-Assertion`, so the Worker is unchanged. Else the command fails with
  `not logged in: run hive login` (exit 3).
- **`hive login`** (`src/accessLogin.ts`, `oauth4webapi`): an unauthenticated request to `apiUrl` gets Access's
  401 with `resource_metadata` (RFC 9728), then OAuth discovery, dynamic client registration with a
  `http://127.0.0.1:<OS-chosen port>/callback` redirect, Authorization Code + PKCE (S256) in the system browser
  (`open` / `xdg-open` / `explorer.exe`; the URL is also printed for a headless machine). It stores
  `oauth: {authorizationServer, clientId, accessToken, refreshToken, expiresAt}`.
- **One store for the CLI and Electron.** Both read and write the `oauth` grant in this file, so a login or refresh
  by either is seen by the other. Each token request re-reads the file. A token within 30 s of expiry is refreshed
  and the rotated tokens are written back. Access rotates refresh tokens, so on `invalid_grant` the file is read
  again and a grant the other client refreshed meanwhile is used. Only then does the CLI open the browser again;
  without a stored grant it fails with `LOGIN_REQUIRED` (exit 3).
- **Logout and revocation.** `hive logout` deletes the grant from the file, for Electron too. Access session
  revocation is invisible to the Worker until the current assertion expires (access tokens live 15 min).
- **Executor service token.** `executor run` (and the standalone executor) adds `CF-Access-Client-Id` /
  `CF-Access-Client-Secret` to every executor and Run request, next to the device token (`X-Hive-Token`), from
  `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` or `accessClientId` / `accessClientSecret`. Store them with
  `device register --access-client-id <id> --access-client-secret-file <path|->` (the secret is read from a file
  so it stays out of shell history, and never printed). Each PC gets its own token from Terraform
  (`infra/README.md`); `executor run` never needs a browser.
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
- `src/accessLogin.ts`: Managed OAuth login, refresh and the browser opener (Node only; reused by
  `apps/desktop`).
- `src/cli.ts`: `node:util` `parseArgs` dispatcher; I/O is injected. `src/main.ts`: the entrypoint; `src/deps.ts`: real files, stdin, executor (also used by the desktop app's headless executor mode).

## Tests

`test/cli.test.ts` (Node): argv → request bodies, stdin data, exit codes, `job watch`, output formats, Access
header precedence, service-token headers. `test/accessLogin.test.ts`: login, PKCE pairing, refresh and
`invalid_grant` against a fake Access (stubbed `fetch`, real loopback callback). `test/rotateLogs.test.ts`: log
rotation in a temp dir. The
end-to-end loop is `apps/api-worker/test/cli.test.ts`.

## Known gaps

- Managed OAuth and service tokens are implemented but not run against a real Access tenant (G-02). Adding a PC
  means a `terraform apply` for its service token; there is no runtime token creation.
- No local operation store: after a network timeout, query `hive op get <id>` and resend with the same
  `--operation-id` / `--idempotency-key` by hand.
- No offline queue (`--offline-queue`, exit 8).
- No installed `hive` binary on PATH yet: run it through Bun (alias above).
- No `event inspect`, `subscription update / delete / resume`, `task cancel` or `task plan --remove` yet. `job start --wait` watches the
  Job, not the Task; complete the Task with `task complete`.
