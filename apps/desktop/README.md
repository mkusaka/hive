# @hive/desktop

The Electron desktop app (docs/architecture.md §20.1, §21), Phase 2 UI slice. It talks to the api-worker with
the credentials file the `hive` CLI writes, shows the Phase 1 state, posts channel messages that @mention Bots (`message.post`) and sends `job.cancel` for a Job.

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
  `HIVE_SCREENSHOT_DELAY_MS` (default 5000) after the first load. `HIVE_OPEN_BOT=<bot id>` opens that Bot's panel at
  start (sent as `openBot` in the config reply). Both are ignored in a packaged app.
- **Tooling.** `electron-vite` is the one build dependency: it builds main, preload and renderer with Vite and
  starts Electron with the dev server URL. There is no React plugin: esbuild's automatic JSX runtime is enough,
  so there is no fast refresh (edits reload the page) and no inline preamble script to allow in the CSP. Main
  changes need a restart of `dev`.

## Views

Dark theme (CSS variables in `style.css`: one light base mixed into every grey, accent / danger / added colors).
The sidebar (UI-04, Slack's layout) starts with the workspace name and a "Find a conversation…" box that filters
every section by name, then the view rows (Inbox, Activity, Approvals with the pending count, Search, Memory,
Status), then the sections, each collapsible from its grey header (remembered in `localStorage`): **Starred** (pinned
items in order; when empty, "Drag and drop important stuff here" accepts a drop), the user's **groups**, **Channels**
(`GET /v1/channels`, each with its `lastMessage` as a one-line preview; bot-pair conversations are not listed),
**Direct messages** (`GET /v1/dms`: the Bot's blob, name and latest-message preview), **Bots** (`GET /v1/bots`,
colored initial blobs; a click opens the Bot's DM, creating it with `dm.open` when there is none) and a collapsed
**Hidden (N)**. Sidebar items are `{kind: channel|dm|bot, id}` (a DM by its conversation id). An item
lives in one place: Starred, one group, Hidden, or its kind's section. Right-click or the row's hover "…" opens the
item menu: Pin / Unpin, Move to group (existing groups, "New group…" named inline, Remove from group), Copy ID, Hide
from sidebar / Show in sidebar. Items drag to reorder within Starred or a group (HTML5 drag and drop, also into
them). Pinned / hidden / groups are the user's `GET /v1/sidebar` document, saved with `sidebar.update` optimistically
and in order (each save expects the revision the previous one returned); a 409 re-reads the document and says so.
Ids of deleted Channels / Bots are skipped, not removed. The toggle collapses the sidebar to an icon rail (Starred
first, then the rest; remembered in `localStorage`). The window is frameless (`titleBarStyle: "hiddenInset"`): the
traffic lights sit in the sidebar's top strip, which with the chat header drags the window. Rail items, view rows and
the collapse toggle have a CSS tooltip (`data-tip`, shown after 400 ms) instead of a native `title`.

| View          | Data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel       | Header: a star toggle (= Pin to Starred), the name pill (the topic in small text under it when set), on the right the member count (opens the Channel panel on Members; `memberCount` from `GET /v1/channels`) and "…" (About). "N messages with" the Bots that posted in the loaded page (latest 50, oldest first), one section per day under a divider line with a centered date pill (Today / Yesterday / weekday and date) that sticks to the top while that day scrolls by, left-aligned bubbles: a Bot's blob + name, "You" for the caller's own messages (`userId` = `GET /v1/me`), else the actor id's short form. Bodies render a safe Markdown subset as React elements (`format.ts`: paragraphs, `-` / `*` / numbered lists, bold, inline code, fenced code, links as text + URL). Hover actions: Reply in thread, Copy. A message with replies shows a footer (participant blobs, "N replies", "last reply <time>"); it and Reply in thread open the Thread panel. Mention tokens render as `@name` pills (also in the sidebar preview). Composer: a Tiptap editor, "Message #channel"; typing `@` opens a popup of the Workspace's Bots filtered by the prefix (arrows, Enter / Tab picks, Esc closes), a pick inserts an `@name` pill node, Enter sends, Shift+Enter is a new line. A DM uses the same view: the header is the star and the Bot's blob + name (opens the Bot panel), messages come from `GET /v1/conversations/:id/messages`, the composer says "Message <bot>", its `@` popup offers only that Bot and posts with `conversationId` |
| Bot panel     | Opens from a DM's header, a Bot name in the conversation or a Bot member. **Details**: instructions and tool policy (read-only) and the Bot's Routines across Channels (`GET /v1/routines?botId=`), each with its Channel name; rows as in the Channel panel, without "New routine". **Library**: the Bot's memories. **Computer**: the Executor section and the Devices list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Channel panel | Opens from the `# channel` pill (one right panel at a time), like Slack's channel details. **About** (first): the name, the topic (click to edit; Enter or blur saves with `channel.update`, Escape cancels, at most 250 chars) and the created date. **Members**: `GET /v1/channels/:id/members`: members with their role; Bots as color blobs (opening the Bot panel) with a "…" menu (Remove from channel = `channel.leave`), users as grey circles, "(you)" for the caller; "Add bot" lists the non-member Bots and sends `channel.join`. **Routines**: `GET /v1/routines?conversationId=` (the Channel's conversation): name, schedule line ("Weekdays at 9:00 AM", "Every 20 minutes", "Once October 10 at 9:47 AM", else the cron expression), the assigned Bot, an on / off switch (`routine.pause` / `routine.resume`) and a menu from "…" or a right-click: Pause / Resume, Edit, Run now (`routine.run`), Delete (`routine.delete`, no confirmation). "New routine" and Edit open an inline editor: name, Bot (fixed when editing), `cron` (expression with a live schedule line, IANA zone defaulting to this machine's) or `once` (`datetime-local`), input, misfire. Create sends `routine.create` into the Channel's conversation; Edit sends `routine.update` with `expectedRevision` and only the changed fields (a 409 reloads the list and says so).                                                                                                                                                                                           |
| Thread panel  | Opens from a message's thread footer or Reply in thread, or a Threads row (one right panel at a time; the Bot / Channel panel closes): the root message, its replies oldest first (`GET /v1/conversations/:threadId/messages`, refetched on the parent's `channel:` changes) and the same composer, "Reply…", posting `message.post` with `threadOf` (the first reply creates the thread)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Threads       | The first view row: `GET /v1/threads?participant=me`, threads you started or replied in, newest reply first: Channel / DM, root text, reply count and last reply; a row opens its Channel / DM with the Thread panel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Inbox         | `GET /v1/inbox?botId=` for the picked Bot, with state badges                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Activity      | `GET /v1/jobs?limit=50` with state badges (incl. `waiting_device`, `recovery_required`) and a Cancel button for queued / waiting / active Jobs; selecting a Job shows `GET /v1/jobs/:id` and its Runs; selecting a Run opens the Run Inspector                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Run Inspector | `GET /v1/runs/:id`: state and `persistence` badges, generation, device, started / finished, provider session present, transcript parts / watermark, result; then every page of `GET /v1/runs/:id/transcript` (kind, tool name, redacted text). Without access to the transcript (not in the Run's channel, bot-pair Run) it says so. An Effects table (`GET /v1/effects?runId=`): kind, state, request summary, external URL or id, attempts, last error. Refetched on `run` and `effect` change rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Approvals     | Pending approvals (`GET /v1/approvals?state=pending`): action, argument summary, cwd label, Bot, expires-in; Allow / Deny send `approval.resolve`. An external effect shows as `slack.post` / `github.comment` with the redacted target and text and `cloud`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Search        | Query box → `GET /v1/search`: kind badge, title, snippet and the index's `indexed through` time; a message hit opens its channel in the Channel view                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Memory        | Scope picker (Workspace, member channels, Bots) → `GET /v1/memories`, newest first; the form sends `memory.write` to the picked scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Status        | Workspace, WebSocket state (connected / reconnecting), last sync cursor (tail), unsynced hint count, last sync error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Devices (in the Computer tab): name, OS, online / offline (heartbeat within 45 s; refetched when the tab opens, since
heartbeats write no change rows), capabilities, background capacity, last heartbeat, revoked.

The composer is a Tiptap editor (`@tiptap/react`, `starter-kit` without heading / blockquote / rule / strike /
underline / link, `extension-mention` + `suggestion`, `extension-placeholder`). On send, `toMarkdown` (`format.ts`)
turns the editor document into the message text: mention nodes `{id, label}` become `<@bot:ID>` tokens (a typed,
unpicked `@name` stays text), bold / italic / code marks `**` / `_` / backticks, lists `- ` / `1. `, code blocks
fences, one block per line. Keys: Enter sends (picks while the suggestion is open), Shift+Enter is a new line (a new
item in a list, a newline in code); Markdown shortcuts (`**x**`, `- `, `1. `, three backticks) format as you type; the
editor grows to about 6 lines, then scrolls; it is cleared and refocused after a send. The draft is component state
(not saved per conversation). ProseMirror injects no scripts, so it runs under the CSP below. The composer sends
`message.post` with a fresh operation id and idempotency key. The status line under the composer shows the accepted
operation, "posted, no Bot mentioned" when nobody was mentioned, else polls `GET /v1/operations/:id` every 2 s (up to
10 min) until routing created one Job per mentioned Bot and lists their ids.
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

| `window.hive`       | Channel                | Validation / behavior                                                                                                                                                                                                                             |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.get(path)`     | `hive:api.get`         | `/v1/<segments>[?query]`; segments are `[A-Za-z0-9_-]`, the query also allows URLSearchParams' `+` and `*`, no `..` anywhere                                                                                                                      |
| `api.command(env)`  | `hive:api.command`     | `commandEnvelope(variant [MessagePost, AgentSend, JobCancel, ApprovalResolve, MemoryWrite, ChannelUpdate, RoutineCreate, RoutineUpdate, RoutineDelete, RoutinePause, RoutineResume, RoutineRun, SidebarUpdate])`: only these twelve command types |
| `getConfig()`       | `hive:config`          | `{apiUrl, workspaceId, problem, connection}`; no secrets                                                                                                                                                                                          |
| `onRealtime(cb)`    | `hive:realtime`        | main → renderer: `{type: "connection", state}` and `{type: "sync.changed", cursor, scopes}`                                                                                                                                                       |
| `executor.status()` | `hive:executor.status` | launchd state, pid, last exit code, installed provider / concurrency / argv, plist and log paths, `registered`; never the plist's env values                                                                                                      |
| `executor.start(o)` | `hive:executor.start`  | `{provider: fake\|claude\|codex, concurrency: 1..64}` (strict); installs or replaces the service; `UNAUTHENTICATED` without a device token                                                                                                        |
| `executor.stop()`   | `hive:executor.stop`   | `launchctl bootout` only; the plist stays                                                                                                                                                                                                         |

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
  device token nothing is installed and the Computer tab says to run `hive device register`.
- **Closing the window or quitting the app leaves the service running.**
- **Computer tab, Executor section.** State (not installed / loaded + pid / stopped + last exit code), the installed
  provider and concurrency, the program's first path (to see drift), log paths, a provider select, a concurrency
  input, Start and Stop; polled every 10 s while the tab is open. Start installs the service with the chosen
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
refetch sets by scope, paging, 410 re-bootstrap, failed pull), `test/format.test.ts` (Markdown subset, schedule lines, avatar colors), `test/ipc.test.ts` (path and envelope
rejection, routine commands incl. delete, ApiError mapping, Access header injection) and `test/executor.test.ts` (executor IPC argument rejection,
unregistered device, error mapping; the service module is mocked).

Renderer tests live in `test/ui/*.test.tsx` (happy-dom via a per-file `// @vitest-environment happy-dom`,
@testing-library/react and user-event). `fakeHive.ts` replaces `window.hive` (the IPC surface, `src/shared/api.ts`):
GET paths answer from `fixtures.ts` (a body or a function of the query, unknown paths `NOT_FOUND`), commands and
executor calls are recorded, `emit` pushes Realtime events; `renderApp()` renders `<App />` over the fixtures. One
file per view: sidebar, chat, Bot panel, Channel panel, and the Inbox / Activity / Approvals / Search / Memory /
Status views. Every change to `src/renderer` adds or updates a test here.

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
- Chat UI (UI-02): sidebar previews come from the channel list, refetched whole on every `channel:*` change row (no
  revision merge). No reply threads, reactions, voice,
  labels, sharing or avatar images; links in messages are text (the window denies opening links); Markdown is a small
  subset (no headings, tables, nested lists or images). The Bot panel's Routines and memories load when a tab opens
  and after its own commands (no change-row refetch), so a Routine fired or changed elsewhere shows on the next open.
- Executor service: macOS only; no device registration in the app; a Claude Run under launchd was verified only with
  `CLAUDE_CONFIG_DIR` captured from the starting shell (keychain login); launched from Finder, main has
  launchd's minimal `PATH`, which the service then inherits. The Executor section is hidden while the window shows
  the Login button or a credentials problem.
- Sidebar (UI-04): no Delete in the item menu (there is no `channel.delete` command) and no Mark as Unread (no read
  state). Groups cannot be renamed; a group disappears with its last item. The workspace name has no menu.
- Search / Memory: one page of hits (no cursor paging), no kind filter, no memory delete or supersede; the Memory
  view refetches only on its own changes (memory change rows do not refresh it).
- Approvals: the Bash command summary is shown as text without a diff view or the full input (it never leaves the
  device); an effect approval shows at most 2 KiB of the text; no OS notification for a new approval.
- Effects: shown only in the Run Inspector (no workspace-wide list) and without `effect.resolve` buttons (use
  `hive effect resolve`). The external URL is plain text because the window denies opening links.
