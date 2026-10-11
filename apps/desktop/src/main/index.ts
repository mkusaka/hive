// Electron main: owns the Access assertion, all HTTP and the Realtime WebSocket (docs/architecture.md §20.1).
// The renderer gets only the typed IPC surface in src/shared/api.ts.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@hive/cli/client";
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { channels, type HiveConfig, type RealtimeEvent } from "../shared/api.ts";
import { handlers } from "./ipc.ts";

// Same file and env override as the CLI (apps/cli/src/main.ts).
const credentialsFile = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "hive",
  "credentials.json",
);
type Credentials = { apiUrl?: string; accessJwt?: string; workspaceId?: string };
const loadCredentials = async (): Promise<Credentials> => {
  const creds = await readFile(credentialsFile, "utf8").then(
    (data) => JSON.parse(data) as Credentials,
    () => ({}),
  );
  return process.env.HIVE_ACCESS_JWT ? { ...creds, accessJwt: process.env.HIVE_ACCESS_JWT } : creds;
};

const rendererUrl = new URL(
  process.env.ELECTRON_RENDERER_URL ??
    pathToFileURL(fileURLToPath(new URL("../renderer/index.html", import.meta.url))).href,
).href;

/** Reconnects with capped exponential backoff plus jitter; every message is only a refetch hint (§12.2). */
const connectRealtime = (url: URL, accessJwt: string, send: (event: RealtimeEvent) => void) => {
  let delay = 1000;
  const open = () => {
    // Node's WebSocket (undici) accepts headers; the browser one in the renderer cannot.
    const ws = new WebSocket(url, { headers: { "Cf-Access-Jwt-Assertion": accessJwt } });
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
    ws.addEventListener("close", () => {
      send({ type: "connection", state: "reconnecting" });
      setTimeout(open, delay + Math.random() * 1000);
      delay = Math.min(delay * 2, 30_000);
    });
  };
  open();
};

const createWindow = async () => {
  const creds = await loadCredentials();
  const problem =
    !creds.apiUrl || !creds.workspaceId
      ? `no apiUrl / workspaceId in ${credentialsFile}: run the CLI walkthrough first`
      : !creds.accessJwt
        ? "no Access assertion: set HIVE_ACCESS_JWT or accessJwt in the credentials file"
        : null;
  const config = { apiUrl: creds.apiUrl ?? "", workspaceId: creds.workspaceId ?? "", problem };
  // The socket can open before the page subscribes, so the config reply carries the current state.
  let connection: HiveConfig["connection"] = "reconnecting";

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "hive",
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

  const client = createClient({ apiUrl: config.apiUrl, accessJwt: creds.accessJwt, fetch });
  const h = handlers(client);
  ipcMain.handle(
    channels.config,
    guard((): HiveConfig => ({ ...config, connection })),
  );
  ipcMain.handle(channels.get, guard(h.get));
  ipcMain.handle(channels.command, guard(h.command));

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });

  if (!problem && creds.accessJwt) {
    const url = new URL(
      `/v1/realtime?${new URLSearchParams({ workspaceId: config.workspaceId })}`,
      config.apiUrl,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    connectRealtime(url, creds.accessJwt, (event) => {
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

app.on("window-all-closed", () => app.quit());
// Not a top-level await: Electron emits `ready` only after the ESM main module has finished evaluating.
void app.whenReady().then(createWindow);
