// Sandboxed preload: exposes `window.hive` (src/shared/api.ts) and nothing else. Built as CommonJS.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { channels, type HiveApi, type RealtimeEvent } from "../shared/api.ts";

const hive: HiveApi = {
  api: {
    get: (path) => ipcRenderer.invoke(channels.get, path),
    command: (envelope) => ipcRenderer.invoke(channels.command, envelope),
  },
  attachment: {
    pick: () => ipcRenderer.invoke(channels.attachmentPick),
    filePaths: (files) =>
      files.flatMap((file) => {
        const path = webUtils.getPathForFile(file as never);
        return path ? [path] : [];
      }),
    upload: (input) => ipcRenderer.invoke(channels.attachmentUpload, input),
    paste: (input) => ipcRenderer.invoke(channels.attachmentPaste, input),
    dataUrl: (input) => ipcRenderer.invoke(channels.attachmentDataUrl, input),
    save: (input) => ipcRenderer.invoke(channels.attachmentSave, input),
  },
  executor: {
    status: () => ipcRenderer.invoke(channels.executorStatus),
    start: (input) => ipcRenderer.invoke(channels.executorStart, input),
    stop: () => ipcRenderer.invoke(channels.executorStop),
  },
  onRealtime: (cb) => {
    const listener = (_: unknown, event: RealtimeEvent) => cb(event);
    ipcRenderer.on(channels.realtime, listener);
    return () => void ipcRenderer.off(channels.realtime, listener);
  },
  getConfig: () => ipcRenderer.invoke(channels.config),
  setConfig: (patch) => ipcRenderer.invoke(channels.configSet, patch),
  login: () => ipcRenderer.invoke(channels.login),
  logout: () => ipcRenderer.invoke(channels.logout),
  registerDevice: (input) => ipcRenderer.invoke(channels.deviceRegister, input),
};

contextBridge.exposeInMainWorld("hive", hive);
