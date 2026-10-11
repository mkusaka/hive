// @vitest-environment happy-dom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../../src/shared/api.ts";
import { renderApp, sidebar } from "./fakeHive.ts";

/** Renders the app and switches to a sidebar view. */
const open = async (label: string) => {
  const app = renderApp();
  await app.user.click(await (await sidebar()).findByRole("button", { name: label }));
  return app;
};

describe("views", () => {
  it("Inbox lists the selected bot's items", async () => {
    const { hive } = await open("Inbox");
    expect(await screen.findByText("in-1")).toBeTruthy();
    expect(hive.calls.get).toContain("/v1/inbox?botId=bot-1");
  });

  it("Activity lists jobs and cancels an active one", async () => {
    const { user, hive } = await open("Activity");
    expect(await screen.findByText("job-1")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(hive.sent("job.cancel")).toEqual([
      { workspaceId: "ws-1", command: { type: "job.cancel", jobId: "job-1" } },
    ]);
  });

  it("Approvals lists pending approvals and Allow sends approval.resolve", async () => {
    const { user, hive } = await open("Approvals");
    expect(await screen.findByText("rm -rf build")).toBeTruthy();
    expect(screen.getByLabelText("1 pending")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(hive.sent("approval.resolve")).toEqual([
      {
        workspaceId: "ws-1",
        command: { type: "approval.resolve", approvalId: "ap-1", decision: "allow" },
      },
    ]);
  });

  it("Search shows hits and a message hit opens its channel", async () => {
    const { user, hive } = await open("Search");
    await user.type(screen.getByRole("textbox", { name: "Query" }), "release{Enter}");
    expect(hive.calls.get).toContain("/v1/search?workspaceId=ws-1&q=release");
    await user.click(await screen.findByRole("button", { name: /\[release\] notes ready/ }));
    expect(await screen.findByText("release notes ready")).toBeTruthy();
  });

  it("Memory lists workspace memories and writes one", async () => {
    const { user, hive } = await open("Memory");
    expect(await screen.findByText("deploys on Fridays are frozen")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Memory" }), "use bun{Enter}");
    expect(hive.sent("memory.write")).toEqual([
      {
        workspaceId: "ws-1",
        command: {
          type: "memory.write",
          scopeKind: "workspace",
          scopeId: "ws-1",
          content: "use bun",
        },
      },
    ]);
  });

  it("Audit filters by kind and actor, replaces rows, paginates, and opens a channel", async () => {
    const entries = [
      {
        id: "a-1",
        at: "2026-10-12T00:00:00Z",
        actorId: "user-1",
        actorLabel: "Mina",
        kind: "channel.join",
        target: { type: "channel", id: "ch-2", label: "release" },
        summary: "Joined release",
      },
      {
        id: "a-2",
        at: "2026-10-11T00:00:00Z",
        actorId: "user-2",
        actorLabel: "Rin",
        kind: "run.finished",
        target: { type: "run", id: "run-1", label: "Run 1" },
        summary: "Run finished",
      },
      {
        id: "a-3",
        at: "2026-10-10T00:00:00Z",
        actorId: "user-1",
        actorLabel: "Mina",
        kind: "channel.join",
        target: { type: "channel", id: "ch-2", label: "release history" },
        summary: "Joined earlier",
      },
    ];
    const { user } = renderApp({
      get: {
        "/v1/audit": (q) => {
          const filtered = entries.filter(
            (entry) =>
              (!q.get("kinds") || entry.kind === q.get("kinds")) &&
              (!q.get("actor") || entry.actorId === q.get("actor")),
          );
          const offset = Number(q.get("cursor") ?? 0);
          return {
            entries: filtered.slice(offset, offset + 2),
            cursor: offset + 2 < filtered.length ? String(offset + 2) : null,
          };
        },
      },
    });
    await user.click(await (await sidebar()).findByRole("button", { name: "Audit" }));
    expect(await screen.findByText("Run finished")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Joined earlier")).toBeTruthy();
    expect(screen.getByText("Joined release")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Kind" }), "channel.join");
    await waitFor(() => expect(screen.queryByText("Run finished")).toBeNull());
    await user.type(screen.getByRole("textbox", { name: "Actor" }), "user-2");
    expect(await screen.findByText("No audit entries match these filters.")).toBeTruthy();
    await user.clear(screen.getByRole("textbox", { name: "Actor" }));
    await user.click(await screen.findByRole("button", { name: /^release$/ }));
    expect(await screen.findByText("release notes ready")).toBeTruthy();
  });

  it("does not replace a newer audit filter with a late response", async () => {
    const app = renderApp({ get: { "/v1/audit": () => ({ entries: [], cursor: null }) } });
    const get = window.hive.api.get;
    const delayed = Promise.withResolvers<ApiResult>();
    window.hive.api.get = async (path) => {
      const q = new URL(path, "http://hive").searchParams;
      if (q.get("kinds") === "c") return delayed.promise;
      return get(path);
    };
    await app.user.click(await (await sidebar()).findByRole("button", { name: "Audit" }));
    await app.user.type(screen.getByRole("textbox", { name: "Kind" }), "channel.join");
    await screen.findByText("No audit entries match these filters.");
    await act(async () => {
      delayed.resolve({
        ok: true,
        value: {
          entries: [
            {
              id: "late",
              at: "2026-10-12",
              actorId: "user-1",
              actorLabel: "Mina",
              kind: "channel.create",
              target: { type: "channel", id: "ch-1", label: "general" },
              summary: "Obsolete response",
            },
          ],
          cursor: null,
        },
      });
    });
    expect(screen.queryByText("Obsolete response")).toBeNull();
    expect(screen.getByText("No audit entries match these filters.")).toBeTruthy();
  });

  it("Status shows healthy tiles and marks actionable status amber", async () => {
    const app = renderApp({
      get: {
        "/v1/status": {
          sync: { head: "H0", ageMs: 10_000 },
          outbox: { queued: 1, failing: 0, oldestAgeMs: 10 },
          search: { indexedThrough: null, lagMs: 0 },
          jobs: { queued: 2, waitingDevice: 1, recoveryRequired: 1, unknown: 0 },
          effects: { unknown: 0 },
          devices: { online: 0, total: 1 },
          routines: { overdue: 1 },
        },
      },
    });
    await app.user.click(await (await sidebar()).findByRole("button", { name: "Status" }));
    expect(await screen.findByText("Run the outbox pump.")).toBeTruthy();
    expect(screen.getByText("Bring offline devices online.")).toBeTruthy();
    expect((await sidebar()).getByLabelText("Action needed")).toBeTruthy();
  });

  it("keeps a quiet healthy workspace green and refreshes the sidebar warning on hints and polling", async () => {
    const healthy = {
      sync: { head: "H0", ageMs: 86400000 },
      outbox: { queued: 0, failing: 0, oldestAgeMs: 0 },
      search: { indexedThrough: null, lagMs: 0 },
      jobs: { queued: 0, waitingDevice: 0, recoveryRequired: 0, unknown: 0 },
      effects: { unknown: 0 },
      devices: { online: 1, total: 1 },
      routines: { overdue: 0 },
    };
    vi.useFakeTimers();
    try {
      const app = renderApp({ get: { "/v1/status": healthy } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const nav = within(document.querySelector("aside")!);
      fireEvent.click(nav.getByRole("button", { name: "Status" }));
      expect(screen.getByText("1 online / 1 total")).toBeTruthy();
      expect(nav.queryByLabelText("Action needed")).toBeNull();
      expect(document.querySelectorAll(".status-tiles .amber")).toHaveLength(0);
      app.hive.routes["/v1/status"] = { ...healthy, effects: { unknown: 1 } };
      await act(async () =>
        app.hive.emit({ type: "sync.changed", cursor: "H1", scopes: ["workspace:ws-1"] }),
      );
      expect(screen.getByText("Run hive effect resolve.")).toBeTruthy();
      expect(nav.getByLabelText("Action needed")).toBeTruthy();
      app.hive.routes["/v1/status"] = healthy;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000);
      });
      expect(nav.queryByLabelText("Action needed")).toBeNull();
      expect(
        within(screen.getByRole("heading", { name: "Effects" }).closest("article")!).getByText(
          "0 unknown",
        ),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
