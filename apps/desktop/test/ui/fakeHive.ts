// `window.hive` replaced by an in-memory fake (the renderer never calls fetch; IPC is the seam) and `renderApp`.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach } from "vitest";
import { App } from "../../src/renderer/src/App.tsx";
import type {
  ApiResult,
  HiveApi,
  HiveConfig,
  RealtimeEvent,
  UiCommand,
} from "../../src/shared/api.ts";
import { executorStatus, routes as defaultRoutes, ws } from "./fixtures.ts";

/** GET fixtures by pathname: a body, or a function of the query. */
export type Routes = Record<
  string,
  Record<string, unknown> | ((query: URLSearchParams) => Record<string, unknown>)
>;

type Options = {
  get?: Routes;
  command?: (envelope: UiCommand) => ApiResult | undefined;
  attachment?: {
    pick?: () => ApiResult;
    filePaths?: (files: unknown[]) => string[];
    upload?: (input: { target: { workspaceId: string }; path: string }) => ApiResult;
    paste?: (input: { target: { workspaceId: string } }) => ApiResult;
    dataUrl?: (input: { id: string; contentType: string }) => ApiResult;
    save?: (input: { id: string; name: string }) => ApiResult;
  };
  config?: Partial<HiveConfig>;
  executor?: Record<string, unknown>;
  /** `login()`'s answer (default ok); `never` keeps it pending. */
  login?: Awaited<ReturnType<HiveApi["login"]>> | "never";
};

const ok = (value: Record<string, unknown>): ApiResult => ({ ok: true, value });

/** Installs `window.hive`; `routes` stays mutable, every call is recorded, `emit` pushes a Realtime event. */
export const fakeHive = (options: Options = {}) => {
  const routes: Routes = { ...options.get };
  const calls = {
    get: [] as string[],
    command: [] as UiCommand[],
    executor: [] as unknown[],
    attachment: [] as { method: string; input?: unknown }[],
    /** config.set patches, device.register inputs, logins and logouts, in order. */
    setup: [] as unknown[],
  };
  // Like main: each Welcome step changes what the next getConfig returns.
  const config: HiveConfig = {
    apiUrl: "https://hive.test",
    workspaceId: ws,
    problem: null,
    loginRequired: false,
    deviceRegistered: true,
    workspaces: [],
    hostname: "test-pc",
    defaultApiUrl: "",
    connection: "connected",
    ...options.config,
  };
  const listeners = new Set<(event: RealtimeEvent) => void>();
  const hive: HiveApi = {
    api: {
      get: async (path) => {
        calls.get.push(path);
        const url = new URL(path, "http://hive");
        const route = routes[url.pathname];
        if (!route) return { ok: false, error: { code: "NOT_FOUND", message: url.pathname } };
        return ok(typeof route === "function" ? route(url.searchParams) : route);
      },
      command: async (envelope) => {
        calls.command.push(envelope);
        return options.command?.(envelope) ?? ok({});
      },
    },
    attachment: {
      pick: async () => {
        calls.attachment.push({ method: "pick" });
        return options.attachment?.pick?.() ?? ok({ paths: [] });
      },
      filePaths: (files) => options.attachment?.filePaths?.(files) ?? [],
      upload: async (input) => {
        calls.attachment.push({ method: "upload", input });
        return (
          options.attachment?.upload?.(input) ??
          ok({ id: "att-1", name: "file.txt", contentType: "text/plain", size: 1 })
        );
      },
      paste: async (input) => {
        calls.attachment.push({ method: "paste", input });
        return (
          options.attachment?.paste?.(input) ??
          ok({ id: "att-paste", name: "clipboard.png", contentType: "image/png", size: 1 })
        );
      },
      dataUrl: async (input) => {
        calls.attachment.push({ method: "dataUrl", input });
        return (
          options.attachment?.dataUrl?.(input) ?? ok({ dataUrl: "data:image/png;base64,AA==" })
        );
      },
      save: async (input) => {
        calls.attachment.push({ method: "save", input });
        return options.attachment?.save?.(input) ?? ok({ saved: true });
      },
    },
    executor: {
      status: async () => ok(options.executor ?? { installed: false }),
      start: async (input) => {
        calls.executor.push({ start: input });
        return ok({});
      },
      stop: async () => {
        calls.executor.push("stop");
        return ok({});
      },
    },
    onRealtime: (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    getConfig: async () => ({ ...config }),
    setConfig: async (patch) => {
      calls.setup.push({ set: patch });
      Object.assign(config, patch);
      return ok({});
    },
    login: async () => {
      calls.setup.push("login");
      const answer = options.login ?? { ok: true };
      if (answer === "never") return new Promise(() => {});
      if (answer.ok) config.loginRequired = false;
      return answer;
    },
    logout: async () => {
      calls.setup.push("logout");
      config.loginRequired = true;
      return ok({});
    },
    registerDevice: async (input) => {
      calls.setup.push({ register: input });
      config.deviceRegistered = true;
      return ok({});
    },
  };
  window.hive = hive;
  return {
    routes,
    calls,
    config,
    emit: (event: RealtimeEvent) => listeners.forEach((cb) => cb(event)),
    /** Commands of one type, without the random operation / idempotency ids. */
    sent: (type: string) =>
      calls.command
        .filter((e) => e.command.type === type)
        .map(({ workspaceId, command }) => ({ workspaceId, command })),
  };
};

/** `<App />` over the default fixtures; `overrides.get` replaces single routes. */
export const renderApp = (overrides: Options = {}) => {
  const hive = fakeHive({
    executor: executorStatus,
    ...overrides,
    get: { ...defaultRoutes(), ...overrides.get },
  });
  const user = userEvent.setup();
  const view = render(createElement(App));
  return { hive, user, ...view };
};

/** Queries inside the sidebar, once the app has loaded its config. */
export const sidebar = async () =>
  within((await screen.findByRole("button", { name: "Toggle sidebar" })).closest("aside")!);

/** The composer's Tiptap editor (role textbox) once its placeholder reads `placeholder`. */
export const findComposer = (placeholder: string) =>
  waitFor(() => {
    const box = screen.getByRole("textbox", { name: "Message" });
    const shown = box.querySelector("[data-placeholder]")?.getAttribute("data-placeholder");
    if (shown !== placeholder) throw new Error(`composer placeholder: ${shown}`);
    return box;
  });

afterEach(() => {
  cleanup();
  localStorage.clear();
});
