// @vitest-environment happy-dom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiResult, UiCommand } from "../../src/shared/api.ts";
import { renderApp, sidebar } from "./fakeHive.ts";

type Update = Extract<UiCommand["command"], { type: "sidebar.update" }>;
type Prefs = Update["prefs"];
const doc = (prefs: Partial<Prefs>, revision = 4) => ({
  "/v1/sidebar": {
    workspaceName: "acme",
    prefs: { pinned: [], hidden: [], groups: [], ...prefs },
    revision,
  },
});
const ch = (id: string) => ({ kind: "channel" as const, id });
const bot = (id: string) => ({ kind: "bot" as const, id });

/** The item names (channel `# name` or bot name) of the section whose header is `label`. */
const items = async (label: string | RegExp) => {
  const side = await sidebar();
  const head = await side.findByRole("button", { name: label });
  return [...head.closest("section")!.querySelectorAll(".item .conv-text > :first-child")].map(
    (e) => e.textContent,
  );
};
const updates = (hive: ReturnType<typeof renderApp>["hive"]) =>
  hive.sent("sidebar.update").map((s) => s.command as Update);
const rowOf = async (name: string) =>
  (await (await sidebar()).findByText(name)).closest("li") as HTMLElement;

describe("sidebar", () => {
  it("lists bots and channels with a Markdown-stripped preview of the latest message", async () => {
    renderApp();
    const side = await sidebar();
    expect(await side.findByRole("button", { name: "coder" })).toBeTruthy();
    expect(side.getByRole("button", { name: "reviewer" })).toBeTruthy();
    expect(side.getByText("# general")).toBeTruthy();
    expect(side.getByText("Fixed the build")).toBeTruthy();
    expect(side.getByText("No messages yet")).toBeTruthy();
  });

  it("shows the workspace name and the view rows", async () => {
    renderApp();
    const side = await sidebar();
    expect(await side.findByText("acme")).toBeTruthy();
    for (const label of ["Inbox", "Activity", "Approvals", "Search", "Memory", "Status"])
      expect(side.getByRole("button", { name: label })).toBeTruthy();
  });

  it("renders Starred, groups, Channels, Bots and a collapsed Hidden (N) from the server document", async () => {
    const { user } = renderApp({
      get: doc({
        pinned: [ch("ch-2"), ch("gone")],
        groups: [{ name: "Work", items: [bot("bot-2")] }],
        hidden: [bot("bot-1")],
      }),
    });
    // An unknown id (a deleted Channel) is skipped.
    expect(await items("Starred")).toEqual(["# release"]);
    expect(await items("Work")).toEqual(["reviewer"]);
    expect(await items("Channels")).toEqual(["# general"]);
    expect((await sidebar()).queryByRole("button", { name: "Bots" })).toBeNull();
    expect(await items("Hidden (1)")).toEqual([]);
    await user.click((await sidebar()).getByRole("button", { name: "Hidden (1)" }));
    expect(await items("Hidden (1)")).toEqual(["coder"]);
  });

  it("shows the Starred hint when nothing is pinned, and a drop on it pins the item", async () => {
    const { hive } = renderApp();
    const side = await sidebar();
    const hint = await side.findByText("Drag and drop important stuff here");
    fireEvent.dragStart(await rowOf("# general"));
    fireEvent.dragOver(hint);
    fireEvent.drop(hint);
    await vi.waitFor(() =>
      expect(updates(hive)).toEqual([
        {
          type: "sidebar.update",
          prefs: { pinned: [ch("ch-1")], hidden: [], groups: [] },
          expectedRevision: 0,
        },
      ]),
    );
    expect(await items("Starred")).toEqual(["# general"]);
  });

  it("reorders pins by drag and drop and saves the order with the next revision", async () => {
    const { hive } = renderApp({ get: doc({ pinned: [ch("ch-1"), ch("ch-2"), bot("bot-1")] }) });
    expect(await items("Starred")).toEqual(["# general", "# release", "coder"]);
    fireEvent.dragStart(await rowOf("coder"));
    fireEvent.dragOver(await rowOf("# general"));
    fireEvent.drop(await rowOf("# general"));
    expect(await items("Starred")).toEqual(["coder", "# general", "# release"]);
    expect(updates(hive)).toEqual([
      {
        type: "sidebar.update",
        prefs: { pinned: [bot("bot-1"), ch("ch-1"), ch("ch-2")], hidden: [], groups: [] },
        expectedRevision: 4,
      },
    ]);
  });

  it("filters every section by name as you type", async () => {
    const { user } = renderApp({ get: doc({ pinned: [ch("ch-2")] }) });
    const side = await sidebar();
    await side.findByText("# release");
    await user.type(side.getByRole("textbox", { name: "Find a conversation" }), "COD");
    expect(side.queryByText("# release")).toBeNull();
    expect(side.queryByText("# general")).toBeNull();
    expect(side.getByRole("button", { name: "coder" })).toBeTruthy();
    expect(side.queryByRole("button", { name: "reviewer" })).toBeNull();
  });

  it("collapses a section from its header and remembers it", async () => {
    const { user } = renderApp();
    const side = await sidebar();
    await side.findByText("# general");
    await user.click(side.getByRole("button", { name: "Channels" }));
    expect(side.queryByText("# general")).toBeNull();
    expect(JSON.parse(localStorage.getItem("hive.sidebarSections")!)).toEqual({ channels: true });
  });

  it("right-click → Pin moves the item to Starred and sends sidebar.update; Unpin moves it back", async () => {
    // Answers like the server: the new revision.
    const { hive, user } = renderApp({
      command: (e) =>
        e.command.type === "sidebar.update"
          ? { ok: true, value: { revision: e.command.expectedRevision + 1 } }
          : undefined,
    });
    fireEvent.contextMenu(await rowOf("# release"));
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(await items("Starred")).toEqual(["# release"]);
    await user.click((await sidebar()).getByRole("button", { name: "# release actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Unpin" }));
    expect(await items("Channels")).toEqual(["# general", "# release"]);
    await vi.waitFor(() =>
      expect(updates(hive)).toEqual([
        {
          type: "sidebar.update",
          prefs: { pinned: [ch("ch-2")], hidden: [], groups: [] },
          expectedRevision: 0,
        },
        // Saved in order: the second expects the revision the first produced.
        {
          type: "sidebar.update",
          prefs: { pinned: [], hidden: [], groups: [] },
          expectedRevision: 1,
        },
      ]),
    );
  });

  it("moves an item into a new group, then into Hidden, and back", async () => {
    const { hive, user } = renderApp();
    fireEvent.contextMenu(await rowOf("reviewer"));
    await user.click(screen.getByRole("menuitem", { name: /Move to group/ }));
    await user.click(screen.getByRole("menuitem", { name: "New group…" }));
    await user.type(screen.getByRole("textbox", { name: "Group name" }), "Work{Enter}");
    expect(await items("Work")).toEqual(["reviewer"]);
    fireEvent.contextMenu(await rowOf("reviewer"));
    await user.click(screen.getByRole("menuitem", { name: "Hide from sidebar" }));
    // The emptied group is gone; the item is in the collapsed Hidden section.
    expect((await sidebar()).queryByRole("button", { name: "Work" })).toBeNull();
    await user.click((await sidebar()).getByRole("button", { name: "Hidden (1)" }));
    fireEvent.contextMenu(await rowOf("reviewer"));
    await user.click(screen.getByRole("menuitem", { name: "Show in sidebar" }));
    expect(await items("Bots")).toEqual(["coder", "reviewer"]);
    await vi.waitFor(() =>
      expect(updates(hive).map((c) => c.prefs)).toEqual([
        { pinned: [], hidden: [], groups: [{ name: "Work", items: [bot("bot-2")] }] },
        { pinned: [], hidden: [bot("bot-2")], groups: [] },
        { pinned: [], hidden: [], groups: [] },
      ]),
    );
  });

  it("copies the item's id", async () => {
    const { user } = renderApp();
    fireEvent.contextMenu(await rowOf("# general"));
    await user.click(screen.getByRole("menuitem", { name: "Copy ID" }));
    expect(await navigator.clipboard.readText()).toBe("ch-1");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("re-reads the server document after a 409 and shows it", async () => {
    const conflict: ApiResult = {
      ok: false,
      error: { code: "REVISION_CONFLICT", message: "sidebar revision is 5" },
    };
    const { hive, user } = renderApp({
      get: doc({}),
      command: (e) => (e.command.type === "sidebar.update" ? conflict : undefined),
    });
    fireEvent.contextMenu(await rowOf("# general"));
    // Another device pinned #release meanwhile.
    hive.routes["/v1/sidebar"] = doc({ pinned: [ch("ch-2")] }, 5)["/v1/sidebar"];
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(await screen.findByText(/changed on another device/)).toBeTruthy();
    await vi.waitFor(async () => expect(await items("Starred")).toEqual(["# release"]));
  });

  it("loads a channel's messages when it is clicked", async () => {
    const { hive, user } = renderApp();
    await user.click(await (await sidebar()).findByText("# release"));
    expect(await screen.findByText("release notes ready")).toBeTruthy();
    expect(hive.calls.get).toContain("/v1/channels/ch-2/messages?workspaceId=ws-1");
  });

  it("collapses to an icon rail, pinned first, and remembers it", async () => {
    const { user, container } = renderApp({ get: doc({ pinned: [bot("bot-2")] }) });
    const side = await sidebar();
    await side.findByText("# general");
    await user.click(side.getByRole("button", { name: "Toggle sidebar" }));
    expect(side.queryByText("# general")).toBeNull();
    expect(localStorage.getItem("hive.sidebarCollapsed")).toBe("1");
    const rail = [...container.querySelectorAll(".sidebar .item button")].map((b) =>
      b.getAttribute("data-tip"),
    );
    expect(rail).toEqual(["reviewer", "# general", "# release", "coder"]);
  });

  it("starts collapsed when the last session left it collapsed", async () => {
    localStorage.setItem("hive.sidebarCollapsed", "1");
    const { container } = renderApp();
    await (await sidebar()).findByRole("button", { name: "coder" });
    expect(container.querySelector(".sidebar.collapsed")).toBeTruthy();
  });
});
