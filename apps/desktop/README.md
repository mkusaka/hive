# @hive/desktop

The Electron desktop app (docs/architecture.md §20.1, §21), Phase 2 UI slice. It talks to the api-worker with
the credentials file the `hive` CLI writes, shows the Phase 1 state and sends `agent.send` to a Bot.

## Run

Follow "Try it locally" in the root README first (Worker running, Workspace / channel / bot created). Then:

```sh
export HIVE_ACCESS_JWT=$(bun apps/api-worker/scripts/dev-token.ts)
bun run --cwd apps/desktop dev     # downloads the Electron binary on first run, then electron-vite dev
bun run --cwd apps/desktop build   # out/{main,preload,renderer}
```

- **Credentials.** `$XDG_CONFIG_HOME/hive/credentials.json`, else `~/.config/hive/credentials.json`: `apiUrl`,
  `workspaceId` and `accessJwt`; `HIVE_ACCESS_JWT` overrides `accessJwt`, as in the CLI. Without them the window
  shows what is missing. There is no OAuth login (G-02).
- **Screenshot hook (dev only).** `HIVE_SCREENSHOT=<png path>` saves `webContents.capturePage()` once,
  `HIVE_SCREENSHOT_DELAY_MS` (default 5000) after the first load. Ignored in a packaged app.
- **Tooling.** `electron-vite` is the one build dependency: it builds main, preload and renderer with Vite and
  starts Electron with the dev server URL. There is no React plugin: esbuild's automatic JSX runtime is enough,
  so there is no fast refresh (edits reload the page) and no inline preamble script to allow in the CSP. Main
  changes need a restart of `dev`.

## Views

| View     | Data                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------- |
| Channel  | Channels, the selected channel's latest 50 messages oldest first, Bot picker, composer              |
| Inbox    | `GET /v1/inbox?botId=` for the picked Bot, with state badges                                        |
| Activity | `GET /v1/jobs?limit=50` with state badges; selecting a Job shows `GET /v1/jobs/:id`                 |
| Devices  | Name, OS, last heartbeat, revoked                                                                   |
| Status   | Workspace, WebSocket state (connected / reconnecting), last sync cursor (tail), unsynced hint count |

The composer sends `agent.send` (`delivery: "wake"`) with a fresh operation id and idempotency key, shows the
accepted operation, then polls `GET /v1/operations/:id` every 2 s (up to 10 min) until routing created the Job.
Accepted is not started: the Job id appears only after the outbox pump ran (`hive executor run`).

## Sync

`src/renderer/src/sync.ts`, a pure controller (§12.3):

1. **Bootstrap.** `GET /v1/sync/changes` without a cursor gives the head cursor; then every list is loaded.
2. **Pull.** `GET /v1/sync/changes?cursor=` while `hasMore`; the scopes of the returned rows choose what to
   refetch: `channel:*` → messages and inbox (plus the channel list for a `channel` row), `workspace:*` → jobs,
   bots and devices. Pulls are serialized; a hint during a pull runs one more.
3. **410 `CURSOR_EXPIRED`** drops the cursor and bootstraps again.
4. **Triggers.** A `sync.changed` hint, WebSocket (re)connect, window focus and a timer every 50-70 s. The hint's
   own cursor is not used: it only says "something changed".

"Unsynced hints" counts `sync.changed` hints whose changes have not been fetched yet; it stays above zero while
pulls fail.

## Security model (§21, S24)

- `BrowserWindow` with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The preload is built as
  CommonJS (required for a sandboxed preload) and exposes only `window.hive`.
- **The renderer never sees the Access assertion or the device token.** Main reads the credentials, makes every
  HTTP request (through `@hive/cli/client`, which sets `Cf-Access-Jwt-Assertion`) and holds the Realtime socket,
  because a browser WebSocket cannot send custom headers.
- IPC handlers accept calls only from the app's own window, main frame, at the URL main loaded; anything else
  throws. Arguments are validated with Valibot before any request (`src/main/ipc.ts`).
- CSP meta tag: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self';
img-src 'self'`. `'unsafe-inline'` styles are for Vite's dev-time `<style>` injection.
- `setWindowOpenHandler` denies every new window; `will-navigate` to any other URL is prevented.

## IPC surface (`src/shared/api.ts`)

| `window.hive`      | Channel            | Validation / behavior                                                                       |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------- |
| `api.get(path)`    | `hive:api.get`     | `/v1/<segments>[?query]`; segments are `[A-Za-z0-9_-]`, no `..` anywhere                    |
| `api.command(env)` | `hive:api.command` | `commandEnvelope(AgentSend)` from `@hive/contracts`: the UI sends only `agent.send`         |
| `getConfig()`      | `hive:config`      | `{apiUrl, workspaceId, problem, connection}`; no secrets                                    |
| `onRealtime(cb)`   | `hive:realtime`    | main → renderer: `{type: "connection", state}` and `{type: "sync.changed", cursor, scopes}` |

`api.*` never rejects: it resolves to `{ok: true, value}` or `{ok: false, error: {code, message, body?}}`, where
`code` is the `ApiError` code (e.g. `CURSOR_EXPIRED`), `INVALID_ARGS` for rejected arguments, or a CLI client code
(`NETWORK`, `UNAUTHENTICATED`). An error thrown across `ipcMain.handle` would keep only its message.

## Tests

`bun run test` from the repo root (Node environment, Electron is never launched): `test/sync.test.ts` (bootstrap,
refetch sets by scope, paging, 410 re-bootstrap, failed pull) and `test/ipc.test.ts` (path and envelope
rejection, ApiError mapping, Access header injection).

## Known gaps

- No OAuth login (G-02), no approval view, no Run inspector, no threads, no local outbox / `queued_local`.
- G-04 (Access + WebSocket from a native client) is not executed: the socket was verified only against
  `wrangler dev` with a dev assertion. A channel created after the socket opened needs a reconnect for its hints
  (scopes are fixed at upgrade); the periodic pull still picks it up.
- Lists are refetched whole on every relevant change (no revision merge); messages show the latest 50 only.
- Inbox state and Job ids are not linked in the UI; accepted / delivered / started / completed are shown only as
  the raw states of the operation, inbox item and Job.
- No packaging or installer (electron-builder).
