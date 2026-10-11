// Sandboxed preload: exposes `window.hive` (src/shared/api.ts) and nothing else. Built as CommonJS.
import { contextBridge, ipcRenderer } from "electron";
import { channels, type HiveApi, type RealtimeEvent } from "../shared/api.ts";

const hive: HiveApi = {
  api: {
    get: (path) => ipcRenderer.invoke(channels.get, path),
    command: (envelope) => ipcRenderer.invoke(channels.command, envelope),
  },
  onRealtime: (cb) => {
    const listener = (_: unknown, event: RealtimeEvent) => cb(event);
    ipcRenderer.on(channels.realtime, listener);
    return () => void ipcRenderer.off(channels.realtime, listener);
  },
  getConfig: () => ipcRenderer.invoke(channels.config),
};

contextBridge.exposeInMainWorld("hive", hive);
