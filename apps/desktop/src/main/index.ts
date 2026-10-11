// Electron main: owns the Access assertion, all HTTP and the Realtime WebSocket (docs/architecture.md §20.1).
// The renderer gets only the typed IPC surface in src/shared/api.ts. It also owns the executor launchd service, whose
// program is this app started with `--executor` (headless executor mode, see README "Executor service").
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { accessTokens, login, systemBrowser } from "@hive/cli/accessLogin";
import { type Credentials, run } from "@hive/cli/cli";
import { CliError, createClient } from "@hive/cli/client";
import { deps } from "@hive/cli/deps";
import * as service from "@hive/cli/service";
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { channels, type HiveConfig, type RealtimeEvent } from "../shared/api.ts";
import { executorHandlers, handlers } from "./ipc.ts";

// Same file and env override as the CLI (apps/cli/src/main.ts): one credential store, so a login or refresh by
// either client is seen by the other.
const credentialsFile = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "hive",
  "credentials.json",
);
const readCredentials = async (): Promise<Credentials> =>
  readFile(credentialsFile, "utf8").then(
    (data) => JSON.parse(data) as Credentials,
    () => ({}),
  );
const loadCredentials = async (): Promise<Credentials> => {
  const creds = await readCredentials();
  return process.env.HIVE_ACCESS_JWT ? { ...creds, accessJwt: process.env.HIVE_ACCESS_JWT } : creds;
};
// Owner-only, merged like the CLI's saveCredentials.
const saveCredentials = async (patch: Credentials) => {
  await mkdir(dirname(credentialsFile), { recursive: true, mode: 0o700 });
  const data = `${JSON.stringify({ ...(await readCredentials()), ...patch }, null, 2)}\n`;
  await writeFile(credentialsFile, data, { mode: 0o600 });
  await chmod(credentialsFile, 0o600);
};

const rendererUrl = new URL(
  process.env.ELECTRON_RENDERER_URL ??
    pathToFileURL(fileURLToPath(new URL("../renderer/index.html", import.meta.url))).href,
).href;

/** Reconnects with capped exponential backoff plus jitter; every message is only a refetch hint (§12.2). */
const connectRealtime = (
  url: URL,
  accessHeaders: () => Promise<Record<string, string>>,
  send: (event: RealtimeEvent) => void,
) => {
  let delay = 1000;
  const retry = () => {
    send({ type: "connection", state: "reconnecting" });
    setTimeout(() => void open(), delay + Math.random() * 1000);
    delay = Math.min(delay * 2, 30_000);
  };
  const open = async () => {
    // Per attempt, so a reconnect carries a refreshed OAuth token.
    const headers = await accessHeaders().catch(() => null);
    if (!headers) return retry();
    // Node's WebSocket (undici) accepts headers; the browser one in the renderer cannot.
    const ws = new WebSocket(url, { headers });
    ws.addEventListener("open", () => {
      delay = 1000;
      send({ type: "connection", state: "connected" });
    });
    ws.addEventListener("message", (message) => {
      try {
        const data = JSON.parse(String(message.data)) as {
          type?: unknown;
          cursor?: unknown;
          scopes?: unknown;
        };
        if (
          data.type === "sync.changed" &&
          typeof data.cursor === "string" &&
          Array.isArray(data.scopes)
        ) {
          send({ type: "sync.changed", cursor: data.cursor, scopes: data.scopes.map(String) });
        }
      } catch {
        // Not JSON: ignore, hints are optional.
      }
    });
    // An error is always followed by close.
    ws.addEventListener("close", retry);
  };
  void open();
};

const createWindow = async () => {
  const creds = await loadCredentials();
  const problem =
    !creds.apiUrl || !creds.workspaceId
      ? `no apiUrl / workspaceId in ${credentialsFile}: run the CLI walkthrough first`
      : null;
  const config = { apiUrl: creds.apiUrl ?? "", workspaceId: creds.workspaceId ?? "", problem };
  // The socket can open before the page subscribes, so the config reply carries the current state.
  let connection: HiveConfig["connection"] = "reconnecting";

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "hive",
    // Frameless like the reference app: the traffic lights sit in the sidebar's top strip (style.css `.side-top`).
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Only the app's own page in its own window may call main (§21).
  const trusted = (event: IpcMainInvokeEvent) =>
    event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame &&
    event.senderFrame.url === rendererUrl;
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (event: IpcMainInvokeEvent, ...args: A) => {
      if (!trusted(event)) throw new Error("untrusted IPC sender");
      return fn(...args);
    };

  // HIVE_ACCESS_JWT / accessJwt (local dev) wins; otherwise the shared OAuth grant, refreshed silently. Without a
  // usable grant requests fail with LOGIN_REQUIRED and the window shows the Login button.
  const client = createClient({
    apiUrl: config.apiUrl,
    accessJwt: creds.accessJwt,
    accessToken: accessTokens({
      apiUrl: config.apiUrl,
      load: async () => (await readCredentials()).oauth,
      save: (oauth) => saveCredentials({ oauth }),
    }),
    fetch,
  });
  const loginRequired = async () =>
    !problem &&
    (await client.accessHeaders().then(
      () => false,
      (error: unknown) => error instanceof CliError && error.code === "LOGIN_REQUIRED",
    ));
  const h = handlers(client);
  ipcMain.handle(
    channels.config,
    guard(async (): Promise<HiveConfig> => ({
      ...config,
      loginRequired: await loginRequired(),
      connection,
      // Dev-only hook for screenshots of the Bot panel.
      ...(!app.isPackaged && process.env.HIVE_OPEN_BOT
        ? { openBot: process.env.HIVE_OPEN_BOT }
        : {}),
    })),
  );
  // Browser login (PKCE on a loopback redirect); the grant goes to the shared file. Never throws across IPC.
  ipcMain.handle(
    channels.login,
    guard(() =>
      login(
        config.apiUrl,
        systemBrowser((line) => console.log(line)),
      ).then(
        async (oauth) => {
          await saveCredentials({ oauth });
          return { ok: true as const };
        },
        (error: unknown) => ({ ok: false as const, message: String(error) }),
      ),
    ),
  );
  ipcMain.handle(channels.get, guard(h.get));
  ipcMain.handle(channels.command, guard(h.command));
  const e = executorHandlers(servicedProgram(), async () => registered(await loadCredentials()));
  ipcMain.handle(channels.executorStatus, guard(e.status));
  ipcMain.handle(channels.executorStart, guard(e.start));
  ipcMain.handle(channels.executorStop, guard(e.stop));

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });

  if (!problem) {
    const url = new URL(
      `/v1/realtime?${new URLSearchParams({ workspaceId: config.workspaceId })}`,
      config.apiUrl,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    connectRealtime(url, client.accessHeaders, (event) => {
      if (event.type === "connection") connection = event.state;
      if (!win.isDestroyed()) win.webContents.send(channels.realtime, event);
    });
  }

  // Dev-only screenshot hook for manual verification: HIVE_SCREENSHOT=<png path>.
  const screenshot = process.env.HIVE_SCREENSHOT;
  if (screenshot && !app.isPackaged) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(
        async () => {
          await writeFile(screenshot, (await win.webContents.capturePage()).toPNG());
          console.log(`screenshot saved: ${screenshot}`);
        },
        Number(process.env.HIVE_SCREENSHOT_DELAY_MS ?? 5000),
      );
    });
  }

  await win.loadURL(rendererUrl);
};

/** What the launchd service runs: this Electron build in headless executor mode; `--provider` etc. are appended. */
const servicedProgram = () => [process.execPath, app.getAppPath(), "--executor"];
const registered = (creds: Credentials) => Boolean(creds.deviceToken && creds.apiUrl);

/**
 * On every window-mode start: (re)install the service when it is missing, stopped or runs another program, keeping
 * the installed provider / concurrency (default claude, 1). Quitting the app leaves the service running (§20.1).
 */
const reconcileService = async () => {
  if (process.platform !== "darwin") return;
  if (!registered(await loadCredentials()))
    return console.log("executor service: device not registered, not installed");
  const current = await service.status();
  const result = await service.ensure({
    program: servicedProgram(),
    provider: current.provider ?? "claude",
    concurrency: current.concurrency ?? 1,
  });
  console.log(
    `executor service ${result.label}: ${result.changed ? "installed" : "unchanged"}, ` +
      `provider ${result.provider}, concurrency ${result.concurrency}, pid ${result.pid ?? "none"}`,
  );
};

// Not a top-level await: Electron emits `ready` only after the ESM main module has finished evaluating.
if (app.commandLine.hasSwitch("executor")) {
  // Headless executor mode (the launchd service): the CLI's `executor run`, then exit with the loop.
  void app.whenReady().then(async () => {
    app.dock?.hide();
    const options = process.argv.slice(process.argv.indexOf("--executor") + 1);
    app.exit(await run(["executor", "run", ...options], deps));
  });
} else {
  app.on("window-all-closed", () => app.quit());
  void app.whenReady().then(() => {
    // Independent of the window: a failed page load must not skip the reconcile.
    void reconcileService().catch((error: unknown) =>
      console.error(`executor service: ${String(error)}`),
    );
    return createWindow();
  });
}
