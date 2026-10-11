# @hive/desktop

The Electron desktop app (docs/architecture.md §20.1, §21), Phase 2 UI slice. It talks to the api-worker with
the credentials file the `hive` CLI writes, shows the Phase 1 state, sends `agent.send` to a Bot and `job.cancel` for a Job.

## Run

Follow "Try it locally" in the root README first (Worker running, Workspace / channel / bot created). Then:

```sh
export HIVE_ACCESS_JWT=$(bun apps/api-worker/scripts/dev-token.ts)
bun run --cwd apps/desktop dev     # downloads the Electron binary on first run, then electron-vite dev
bun run --cwd apps/desktop build   # out/{main,preload,renderer}
```

- **Credentials.** `$XDG_CONFIG_HOME/hive/credentials.json`, else `~/.config/hive/credentials.json`: `apiUrl` and
  `workspaceId` (without them the window shows what is missing). Auth follows the CLI and shares its store:
  `HIVE_ACCESS_JWT` / `accessJwt` for `wrangler dev`, else the OAuth grant in the same file (`hive login` and the app
  each see the other's login and refreshes; see `apps/cli/README.md`, Credentials). Only when the file has no usable
  grant does the window show a Login button, which runs the same browser login (`@hive/cli/accessLogin`) and writes
  the grant to the file.
- **Screenshot hook (dev only).** `HIVE_SCREENSHOT=<png path>` saves `webContents.capturePage()` once,
  `HIVE_SCREENSHOT_DELAY_MS` (default 5000) after the first load. Ignored in a packaged app.
- **Tooling.** `electron-vite` is the one build dependency: it builds main, preload and renderer with Vite and
  starts Electron with the dev server URL. There is no React plugin: esbuild's automatic JSX runtime is enough,
  so there is no fast refresh (edits reload the page) and no inline preamble script to allow in the CSP. Main
  changes need a restart of `dev`.

## Views

| View          | Data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel       | Channels, the selected channel's latest 50 messages oldest first, Bot picker, composer                                                                                                                                                                                                                                                                                                                                                                                                                |
| Inbox         | `GET /v1/inbox?botId=` for the picked Bot, with state badges                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Activity      | `GET /v1/jobs?limit=50` with state badges (incl. `waiting_device`, `recovery_required`) and a Cancel button for queued / waiting / active Jobs; selecting a Job shows `GET /v1/jobs/:id` and its Runs; selecting a Run opens the Run Inspector                                                                                                                                                                                                                                                        |
| Run Inspector | `GET /v1/runs/:id`: state and `persistence` badges, generation, device, started / finished, provider session present, transcript parts / watermark, result; then every page of `GET /v1/runs/:id/transcript` (kind, tool name, redacted text). Without access to the transcript (not in the Run's channel, bot-pair Run) it says so. An Effects table (`GET /v1/effects?runId=`): kind, state, request summary, external URL or id, attempts, last error. Refetched on `run` and `effect` change rows |
| Approvals     | Pending approvals (`GET /v1/approvals?state=pending`): action, argument summary, cwd label, Bot, expires-in; Allow / Deny send `approval.resolve`. An external effect shows as `slack.post` / `github.comment` with the redacted target and text and `cloud`. The nav shows the pending count                                                                                                                                                                                                         |
| Search        | Query box → `GET /v1/search`: kind badge, title, snippet and the index's `indexed through` time; a message hit opens its channel in the Channel view                                                                                                                                                                                                                                                                                                                                                  |
| Memory        | Scope picker (Workspace, member channels, Bots) → `GET /v1/memories`, newest first; the form sends `memory.write` to the picked scope                                                                                                                                                                                                                                                                                                                                                                 |
| Devices       | Name, OS, online / offline (heartbeat within 45 s; refetched when the view opens, since heartbeats write no change rows), capabilities, background capacity, last heartbeat, revoked                                                                                                                                                                                                                                                                                                                  |
| Status        | Workspace, WebSocket state (connected / reconnecting), last sync cursor (tail), unsynced hint count                                                                                                                                                                                                                                                                                                                                                                                                   |

The composer sends `agent.send` (`delivery: "wake"`) with a fresh operation id and idempotency key, shows the
accepted operation, then polls `GET /v1/operations/:id` every 2 s (up to 10 min) until routing created the Job.
Accepted is not started: the Job id appears only after the outbox pump ran (`hive executor run`).

## Sync

`src/renderer/src/sync.ts`, a pure controller (§12.3):

1. **Bootstrap.** `GET /v1/sync/changes` without a cursor gives the head cursor; then every list is loaded.
2. **Pull.** `GET /v1/sync/changes?cursor=` while `hasMore`; the scopes of the returned rows choose what to
   refetch: `channel:*` → messages and inbox (plus the channel list for a `channel` row), `workspace:*` → jobs,
   bots, devices and approvals, plus the inspected Run for a `run` row (e.g. persistence turning `complete`). Pulls are serialized; a hint during a pull runs one more.
3. **410 `CURSOR_EXPIRED`** drops the cursor and bootstraps again.
4. **Triggers.** A `sync.changed` hint, WebSocket (re)connect, window focus and a timer every 50-70 s. The hint's
   own cursor is not used: it only says "something changed".

"Unsynced hints" counts `sync.changed` hints whose changes have not been fetched yet; it stays above zero while
pulls fail.

## Security model (§21, S24)

- `BrowserWindow` with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The preload is built as
  CommonJS (required for a sandboxed preload) and exposes only `window.hive`.
- **The renderer never sees the Access assertion or the device token.** Main reads the credentials, makes every
  HTTP request (through `@hive/cli/client`, which sets `Cf-Access-Jwt-Assertion` or the OAuth
  `Authorization: Bearer` header) and holds the Realtime socket, because a browser WebSocket cannot send custom
  headers. The upgrade carries the same header, fetched per attempt so a reconnect uses a refreshed token.
- IPC handlers accept calls only from the app's own window, main frame, at the URL main loaded; anything else
  throws. Arguments are validated with Valibot before any request (`src/main/ipc.ts`).
- CSP meta tag: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self';
img-src 'self'`. `'unsafe-inline'` styles are for Vite's dev-time `<style>` injection.
- `setWindowOpenHandler` denies every new window; `will-navigate` to any other URL is prevented.

## IPC surface (`src/shared/api.ts`)

| `window.hive`       | Channel                | Validation / behavior                                                                                                                                   |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.get(path)`     | `hive:api.get`         | `/v1/<segments>[?query]`; segments are `[A-Za-z0-9_-]`, the query also allows URLSearchParams' `+` and `*`, no `..` anywhere                            |
| `api.command(env)`  | `hive:api.command`     | `commandEnvelope(variant [AgentSend, JobCancel, ApprovalResolve, MemoryWrite])`: only `agent.send`, `job.cancel`, `approval.resolve` and `memory.write` |
| `getConfig()`       | `hive:config`          | `{apiUrl, workspaceId, problem, connection}`; no secrets                                                                                                |
| `onRealtime(cb)`    | `hive:realtime`        | main → renderer: `{type: "connection", state}` and `{type: "sync.changed", cursor, scopes}`                                                             |
| `executor.status()` | `hive:executor.status` | launchd state, pid, last exit code, installed provider / concurrency / argv, plist and log paths, `registered`; never the plist's env values            |
| `executor.start(o)` | `hive:executor.start`  | `{provider: fake\|claude\|codex, concurrency: 1..64}` (strict); installs or replaces the service; `UNAUTHENTICATED` without a device token              |
| `executor.stop()`   | `hive:executor.stop`   | `launchctl bootout` only; the plist stays                                                                                                               |

`api.*` never rejects: it resolves to `{ok: true, value}` or `{ok: false, error: {code, message, body?}}`, where
`code` is the `ApiError` code (e.g. `CURSOR_EXPIRED`), `INVALID_ARGS` for rejected arguments, or a CLI client code
(`NETWORK`, `UNAUTHENTICATED`). An error thrown across `ipcMain.handle` would keep only its message.

## Executor service

The app owns the Local Executor's launchd user agent `com.hive.executor` (docs/architecture.md §20.1); its program is
this app in headless executor mode, so the service always runs the installed Electron build.

- **Headless mode.** `<Electron> <app path> --executor --provider P --concurrency N` opens no window, hides the Dock
  icon and runs the CLI's `executor run` (`run()` from `@hive/cli/cli` with `deps` from `@hive/cli/deps`, the same
  code path as `hive executor run`), then exits with the loop. SIGTERM stops it within 10 s as in the CLI.
- **Reconcile on every start.** In window mode on macOS, when the credentials file has `deviceToken` and `apiUrl`,
  main renders the plist for this build (`[process.execPath, app.getAppPath(), "--executor"]` plus the installed
  provider / concurrency, default `claude`, 1) and reinstalls it unless the file on disk is byte-identical and the
  agent runs with a pid (`ensure` in `apps/cli/src/service.ts`). It logs the result (names, no values). Without a
  device token nothing is installed and the Devices view says to run `hive device register`.
- **Closing the window or quitting the app leaves the service running.**
- **Devices view, Executor section.** State (not installed / loaded + pid / stopped + last exit code), the installed
  provider and concurrency, the program's first path (to see drift), log paths, a provider select, a concurrency
  input, Start and Stop; polled every 10 s while the view is open. Start installs the service with the chosen
  options. Stop only unloads it (`launchctl bootout`): the plist stays and the next app start brings it back.
  Permanent removal is `hive executor uninstall`.
- **Program path.** In dev, `process.execPath` is the Electron binary under `node_modules` and `app.getAppPath()` is
  `apps/desktop` (its `package.json` `main` is `out/main/index.js`), so the service runs the last `build` / `dev`
  output. A packaged app would give the `.app` binary and its `app.asar`; packaging is not done yet.
- **Bundling.** main bundles `@hive/cli`, `@hive/contracts` and `@hive/executor` (TypeScript sources); the Claude
  Agent SDK and `zod` are app dependencies and stay external, so the SDK resolves its own files at runtime.
- **Environment.** The plist captures main's environment like `hive executor install` (`PATH`, `HOME`, and
  `XDG_CONFIG_HOME` / `CLAUDE_CONFIG_DIR` / `CLAUDE_CODE_OAUTH_TOKEN` when set). A start with a different set of
  these (another shell, Finder) reinstalls the service with that set.

## Tests

`bun run test` from the repo root (Node environment, Electron is never launched): `test/sync.test.ts` (bootstrap,
refetch sets by scope, paging, 410 re-bootstrap, failed pull), `test/ipc.test.ts` (path and envelope
rejection, ApiError mapping, Access header injection) and `test/executor.test.ts` (executor IPC argument rejection,
unregistered device, error mapping; the service module is mocked).

## Known gaps

- OAuth login is not run against a real Access tenant (G-02). A grant that expires while the window is open shows
  as request errors until the app restarts (the Login button is chosen at startup and after a login), and Access's handling of a Bearer token on a
  WebSocket upgrade is not documented by Cloudflare (G-04). No threads, no local outbox / `queued_local`.
- Run Inspector: loads every transcript page at once (no lazy paging); no raw transcript view, observation
  history, input snapshot or Agent Tree.
- G-04 (Access + WebSocket from a native client) is not executed: the socket was verified only against
  `wrangler dev` with a dev assertion. A channel created after the socket opened needs a reconnect for its hints
  (scopes are fixed at upgrade); the periodic pull still picks it up.
- Lists are refetched whole on every relevant change (no revision merge); messages show the latest 50 only.
- Inbox state and Job ids are not linked in the UI; accepted / delivered / started / completed are shown only as
  the raw states of the operation, inbox item and Job.
- No packaging or installer (electron-builder).
- Executor service: macOS only; no device registration in the app; a Claude Run under launchd was verified only with
  `CLAUDE_CONFIG_DIR` captured from the starting shell (keychain login); launched from Finder, main has
  launchd's minimal `PATH`, which the service then inherits. The Executor section is hidden while the window shows
  the Login button or a credentials problem.
- Search / Memory: one page of hits (no cursor paging), no kind filter, no memory delete or supersede; the Memory
  view refetches only on its own changes (memory change rows do not refresh it).
- Approvals: the Bash command summary is shown as text without a diff view or the full input (it never leaves the
  device); an effect approval shows at most 2 KiB of the text; no OS notification for a new approval.
- Effects: shown only in the Run Inspector (no workspace-wide list) and without `effect.resolve` buttons (use
  `hive effect resolve`). The external URL is plain text because the window denies opening links.
