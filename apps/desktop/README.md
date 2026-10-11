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

- **Credentials.** `$XDG_CONFIG_HOME/hive/credentials.json`, else `~/.config/hive/credentials.json`: `apiUrl`,
  `workspaceId` and `deviceToken` (what is missing puts the Welcome screen on that step, below). Auth follows the CLI
  and shares its store: `HIVE_ACCESS_JWT` / `accessJwt` for `wrangler dev`, else the OAuth grant in the same file
  (`hive login` and the app each see the other's login and refreshes; see `apps/cli/README.md`, Credentials).
- **`HIVE_SKIP_SERVICE=1` (dev only).** Skips the executor service reconcile, at start and after Set up this PC. The
  plist is per user, not per `XDG_CONFIG_HOME`, so a run against a scratch config dir must set it or it replaces
  the real service.
- **Screenshot hook (dev only).** `HIVE_SCREENSHOT=<png path>` saves `webContents.capturePage()` once,
  `HIVE_SCREENSHOT_DELAY_MS` (default 5000) after the first load. `HIVE_OPEN_BOT=<bot id>` opens that Bot's panel at
  start (sent as `openBot` in the config reply). Both are ignored in a packaged app.
- **Tooling.** `electron-vite` is the one build dependency: it builds main, preload and renderer with Vite and
  starts Electron with the dev server URL. There is no React plugin: esbuild's automatic JSX runtime is enough,
  so there is no fast refresh (edits reload the page) and no inline preamble script to allow in the CSP. Main
  changes need a restart of `dev`.

## External session privacy

External CLI collection is off by default; `hive collect enable` opts the executor into periodic imports, while
`hive collect run` requests one manual import. It reads Claude Code JSONL under `$CLAUDE_CONFIG_DIR/projects`
(default `~/.claude/projects`) and Codex JSONL under `~/.codex/sessions` without changing them. Imported
user / assistant text and tool summaries redact token / secret / key assignments; environment dumps, provider
configuration and private reasoning are omitted. Session metadata and transcripts are limited to the importing
device owner or workspace owner, even after linking to a Task. The renderer makes no HTTP requests: all API
traffic goes through the main process over IPC.

## Welcome / first run (LOGIN-01)

Until the app can load, the window is a full-window dark Welcome screen (the hive mark, the name, the tagline, one
pill button; the whole screen drags the frameless window). Each step writes to the shared credentials file through
main and re-reads the config, which picks the next step:

1. **No `apiUrl`:** an API URL field (prefilled from `HIVE_API_URL`) above **Sign in →**; `config.set` accepts an
   https URL or `http://localhost`. The footer shows the API host with **Change** once one is set.
2. **No usable grant:** **Sign in →** runs the CLI's browser login (Access Managed OAuth); while it waits the button
   reads "Waiting for the browser…" with Cancel, and a failure shows under it. `HIVE_ACCESS_JWT` skips this step.
3. **No `workspaceId`:** `GET /v1/me` lists the user's Workspaces (`workspaces: [{id, name}]`): **Choose a
   workspace**, or with none **Create a workspace** (`workspace.create` with an id slugged from the name plus a
   random suffix).
4. **No `deviceToken`:** **Set up this PC** (name prefilled from `os.hostname()`) runs `hive device register`
   (the CLI's `run` and deps; its stdout, which carries the token, is dropped), then the service reconcile. **Skip
   for now** opens the app for this window; the Computer tab then shows the same card.

**Account menu.** The avatar at the bottom of the sidebar (also in the collapsed rail; the first letter of the
`label` from `GET /v1/me`, the user's email) opens Settings (the Status view for now) and **Sign out**. Sign out
asks first in an in-app dialog (Cancel, or Escape; Sign out is focused), then runs `hive logout`: the OAuth grant
goes, the device token and the service stay, and the window returns to Sign in.

## Views

Dark theme (CSS variables in `style.css`: one light base mixed into every grey, accent / danger / added colors).
The sidebar (UI-04, Slack's layout) starts with the workspace name and a "Find a conversation…" box that filters
every section by name, then the view rows (Inbox, Activity, Audit, Approvals with the pending count, Search, Memory,
Status with an amber dot when action is needed), then the sections, each collapsible from its grey header (remembered in `localStorage`): **Starred** (pinned
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

| View          | Data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel       | Header: a star toggle (= Pin to Starred), name pill and topic, member count (opens Channel panel Members; `memberCount` from `GET /v1/channels`), and a pulsing blob for each member Bot that is reading (queued Job) or working (active Run) from `GET /v1/channels/:id/presence` (refetched with Jobs, ROUTE-02). Messages, Markdown, mentions, reply and thread composer behavior are as described above; a Channel-only reply addresses the posting Bot with `replyToMessageId`.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Bot panel     | Opens from a DM header, Bot name, or Bot member. **Details** has instructions; Skills (name, description, instructions; owner-only add/edit/remove through `bot.update` with `expectedRevision`); tool policy; owner-only management toggles for subscriptions, routines, channels and Bots that preserve the remaining policy; and the Bot's Routines across Channels (`GET /v1/routines?botId=`). **Nightly memory consolidation** pauses or resumes the system consolidation Routine. **Library** has Bot memories, a source filter, consolidated badges and merged counts, and Promote / Dismiss actions for Workspace proposals. **Computer** has the Executor section and Devices list.                                                                                                                                                                                                                                      |
| Channel panel | Opens from `# channel`; only one right panel at a time. **About** has name, editable topic (`channel.update`) created date, latest Summary with its covered message range, and **Summarize now**. **Members** uses `GET /v1/channels/:id/members`: every row shows role; Bots have color blobs, open the Bot panel, and show presence (`reading` / `working` / `idle`); users have grey circles and `(you)` for the caller. When `canManage`, Add member fetches `GET /v1/users`, selects a user or Bot and role, and each menu changes role or removes it with `channel.member.add`, `channel.member.update`, and `channel.member.remove`. **Routines** uses `GET /v1/routines?conversationId=`: schedule, assigned Bot, enabled switch, actions, and inline create/edit with optimistic revision handling. Schedules support cron, once, webhook (showing its URL and secret once; secret rotation) and filtered event triggers. |
| Thread panel  | Opens from a message footer, Reply in thread, or Threads. It has the root, replies oldest first (`GET /v1/conversations/:threadId/messages`, refreshed on `channel:` changes), and a `Reply…` composer posting `message.post` with `threadOf`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Threads       | `GET /v1/threads?participant=me`, newest reply first: Channel / DM, root text, reply count, and last reply; opens its Channel / DM with the Thread panel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Inbox         | `GET /v1/inbox?botId=` for the picked Bot, with state badges.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Activity      | Sessions defaults to **Jobs** (`GET /v1/jobs?limit=50`), including `waiting_device`, `recovery_required`, and grey `passed` for Job / Run `outcome: pass`; queued / waiting / active Jobs can cancel. Selecting Job and Run opens details and Run Inspector. **External** loads `GET /v1/runs?workspaceId=&kind=external`; rows show provider, cwd, repository, title, started and last activity. A Job Task selects external sessions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Run Inspector | `GET /v1/runs/:id`: state, persistence, generation, device, timestamps, provider session, transcript parts / watermark, result, all transcript pages, and Effects (`GET /v1/effects?runId=`). External Runs add **Link to Task**, loading `GET /v1/tasks?workspaceId=` and sending `run.link_task`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Approvals     | Pending `GET /v1/approvals?state=pending`: action, argument summary, cwd label, Bot, expiry; Allow / Deny sends `approval.resolve`. External effects show `slack.post` / `github.comment` with redacted target and text and `cloud`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Search        | Query → `GET /v1/search`: kind, title, snippet, indexed-through time; message hit opens its Channel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Memory        | Scope picker (Workspace, member channels, Bots) and source filter (All, Explicit, Consolidated) → `GET /v1/memories`, newest first; consolidated memories show a badge and merged count; the form sends `memory.write` to the picked scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Status        | Connection and client sync cursor / unsynced visibility plus a 30-second (and `sync.changed`) dashboard of sync lag, outbox, search, Jobs, effects, devices and routines. Amber is only actionable stale/backlog/unknown/offline/overdue state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Audit         | `GET /v1/audit` newest first: time, actor blob, kind, linked Channel / Run / Bot target, and redacted summary. Exact kind and actor filters re-read; cursor paging appends with **Load more**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Devices (in the Computer tab): name, OS, online / offline (heartbeat within 45 s; refetched when the tab opens, since
heartbeats write no change rows), capabilities, background capacity, last heartbeat, revoked.

The composer is a Tiptap editor (`@tiptap/react`, `starter-kit` without heading / blockquote / rule / strike /
underline / link, `extension-mention` + `suggestion`, `extension-placeholder`). On send, `toMarkdown` (`packages/ui-text`)
turns the editor document into the message text: mention nodes `{id, label}` become `<@bot:ID>` tokens (`@everyone`,
offered last in a Channel's main composer, also for a prefix of `all`, becomes `<@everyone>`; a typed,
unpicked `@name` stays text), bold / italic / code marks `**` / `_` / backticks, lists `- ` / `1. `, code blocks
fences, one block per line. Keys: Enter sends (picks while the suggestion is open), Shift+Enter is a new line (a new
item in a list, a newline in code); Markdown shortcuts (`**x**`, `- `, `1. `, three backticks) format as you type; the
editor grows to about 6 lines, then scrolls; it is cleared and refocused after a send. The draft is component state
(not saved per conversation). ProseMirror injects no scripts, so it runs under the CSP below. The composer sends
`message.post` with a fresh operation id and idempotency key. The status line under the composer shows the accepted
operation, "posted, no Bot woken" when nobody was woken, else polls `GET /v1/operations/:id` every 2 s (up to
10 min) until routing is done and lists the Job ids, plus how many busy Bots read the post in their current Job.
Accepted is not started: the Job id appears only after the outbox pump ran (`hive executor run`).

## Attachments (ATTACH-01)

The composer uploads up to ten files through main only: **+** opens the native picker, and files can also be dropped
onto the composer or pasted as images. The renderer never reads file bytes or credentials. Preload resolves dropped
and pasted image files to paths; when Electron gives a pasted image no path, main uses Electron 44's async clipboard
API, writes a temporary image file for the authenticated CLI helper, and removes it after init, upload and complete. Main returns
only `{id, name, contentType, size}`. Chips show each pending file and can remove it before `message.post` sends their
`attachmentIds`. Image attachments are fetched by main as data URLs for inline bubbles; other attachments have a
**Save…** card that opens a native save dialog and downloads through main.

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

## Routine triggers (ROUTINE-02)

The Channel routine editor offers **Repeat (cron)**, **Once**, **Webhook** and **When an event matches**.
Webhook rows read "When a webhook fires"; the editor shows the API hook URL and **Rotate secret**.
Creation and rotation show a copyable secret only in the current editor; closing it drops the value, and
reopening cannot retrieve it. The renderer never saves it in localStorage or the credentials file.
External callers sign raw JSON with HMAC-SHA256 (API README); the hook path bypasses Access only on the custom domain.

Event rows read "When <type> events match". The editor accepts an event type prefix and optional JSON of the
existing Subscription filter AST, validated with the contract before submission. Routines carry `inputText`,
Conversation and Task instead of forwarding only raw events as Subscriptions do. Switching trigger kinds uses
`routine.update` with the current revision; a conflict reloads rather than overwriting another edit.

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
img-src 'self' data:`. `'unsafe-inline'` styles are for Vite's dev-time `<style>` injection; `data:` is only for
  image attachment bytes fetched by main.
- `setWindowOpenHandler` denies every new window; `will-navigate` to any other URL is prevented.

## IPC surface (`src/shared/api.ts`)

| `window.hive`       | Channel                | Validation / behavior                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.get(path)`     | `hive:api.get`         | `/v1/<segments>[?query]`; segments are `[A-Za-z0-9_-]`, the query also allows URLSearchParams' `+` and `*`, no `..` anywhere                                                                                                                                                                                                                                                                                                                                |
| `attachment.*`      | `hive:attachment.*`    | `pick` returns native-selected paths; `upload` validates an absolute local path; `paste` validates the target before main reads a clipboard image into a temporary file; `dataUrl` permits only image MIME types; `save` validates attachment id / file name. Main owns all file bytes and authenticated requests.                                                                                                                                          |
| `api.command(env)`  | `hive:api.command`     | `commandEnvelope(variant [MessagePost, AgentSend, JobCancel, ApprovalResolve, MemoryWrite, MemoryDelete, MemoryPromote, ConversationSummarize, ChannelUpdate, ChannelJoin, ChannelLeave, ChannelMemberAdd, ChannelMemberUpdate, ChannelMemberRemove, DmOpen, BotUpdate, RoutineCreate, RoutineUpdate, RoutineDelete, RoutinePause, RoutineResume, RoutineRun, RoutineRotateSecret, RunLinkTask, SidebarUpdate, WorkspaceCreate])`: only these command types |
| `getConfig()`       | `hive:config`          | `{apiUrl, workspaceId, problem, loginRequired, deviceRegistered, workspaces, hostname, defaultApiUrl, connection}`; no secrets                                                                                                                                                                                                                                                                                                                              |
| `onRealtime(cb)`    | `hive:realtime`        | main → renderer: `{type: "connection", state}` and `{type: "sync.changed", cursor, scopes}`                                                                                                                                                                                                                                                                                                                                                                 |
| `executor.status()` | `hive:executor.status` | launchd state, pid, last exit code, installed provider / concurrency / argv, plist and log paths, `registered`; never the plist's env values                                                                                                                                                                                                                                                                                                                |
| `executor.start(o)` | `hive:executor.start`  | `{provider: fake\|claude\|codex, concurrency: 1..64}` (strict); installs or replaces the service; `UNAUTHENTICATED` without a device token                                                                                                                                                                                                                                                                                                                  |
| `executor.stop()`   | `hive:executor.stop`   | `launchctl bootout` only; the plist stays                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `setConfig(patch)`  | `hive:config.set`      | `{apiUrl?: https URL or http://localhost, workspaceId?: 1..200 chars}` (strict, not empty); merged into the credentials file                                                                                                                                                                                                                                                                                                                                |
| `login()`           | `hive:login`           | the CLI's browser login; `{ok: true}` or `{ok: false, message}`                                                                                                                                                                                                                                                                                                                                                                                             |
| `logout()`          | `hive:logout`          | `hive logout` (drops the OAuth grant only)                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `registerDevice(i)` | `hive:device.register` | `{name: 1..200 chars}` (strict); `hive device register --name --os <platform> --agent-version <app version>`, then the service reconcile; never returns the token                                                                                                                                                                                                                                                                                           |

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
- Welcome (LOGIN-01): Cancel only stops waiting; the CLI's login has no abort, so its loopback listener stays until
  the browser calls back, and a late callback still saves the grant. Skip for now lasts for the window. After Sign
  out the Realtime socket keeps retrying with backoff until the next sign in. With `HIVE_ACCESS_JWT` Sign out has no
  visible effect (the assertion wins). Changing the API URL keeps the old `workspaceId`. The account menu has no Weekly usage, Get mobile, Support or Add account
  (one account per credentials file), and Settings is the Status view.
- Executor service: macOS only; a Claude Run under launchd was verified only with
  `CLAUDE_CONFIG_DIR` captured from the starting shell (keychain login); launched from Finder, main has
  launchd's minimal `PATH`, which the service then inherits. The Executor section is hidden while the window shows
  the Welcome screen.
- Sidebar (UI-04): no Delete in the item menu (there is no `channel.delete` command) and no Mark as Unread (no read
  state). Groups cannot be renamed; a group disappears with its last item. The workspace name has no menu.
- Search / Memory: one page of hits (no cursor paging), no kind filter, no memory delete or supersede; the Memory
  view refetches only on its own changes (memory change rows do not refresh it).
- Approvals: the Bash command summary is shown as text without a diff view or the full input (it never leaves the
  device); an effect approval shows at most 2 KiB of the text; no OS notification for a new approval.
- Effects: shown only in the Run Inspector (no workspace-wide list) and without `effect.resolve` buttons (use
  `hive effect resolve`). The external URL is plain text because the window denies opening links.
