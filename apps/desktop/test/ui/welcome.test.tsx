// @vitest-environment happy-dom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, sidebar } from "./fakeHive.ts";

const signedOut = { loginRequired: true };
const noWorkspace = { workspaceId: "", deviceRegistered: false };

describe("welcome", () => {
  it("first run: saves the API URL prefilled from HIVE_API_URL, then signs in", async () => {
    const { user, hive } = renderApp({
      config: {
        apiUrl: "",
        defaultApiUrl: "https://api.example.com",
        ...signedOut,
        ...noWorkspace,
      },
    });
    const field = await screen.findByRole("textbox", { name: "API URL" });
    expect((field as HTMLInputElement).value).toBe("https://api.example.com");
    expect(screen.getByRole("heading", { name: "hive" })).toBeTruthy();
    expect(screen.getByText("Your team of always-on Bots, working on your own PCs")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Sign in →" }));
    expect(await screen.findByRole("heading", { name: "Create a workspace" })).toBeTruthy();
    expect(hive.calls.setup).toEqual([{ set: { apiUrl: "https://api.example.com" } }, "login"]);
  });

  it("signs in with the browser: waiting state, Cancel, and the login error under the button", async () => {
    const pending = renderApp({ config: signedOut, login: "never" });
    expect(await screen.findByText("hive.test")).toBeTruthy();
    await pending.user.click(screen.getByRole("button", { name: "Sign in →" }));
    expect(screen.getByRole("button", { name: "Waiting for the browser…" })).toBeTruthy();
    await pending.user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Sign in →" })).toBeTruthy();
    pending.unmount();

    const failed = renderApp({ config: signedOut, login: { ok: false, message: "denied" } });
    await failed.user.click(await screen.findByRole("button", { name: "Sign in →" }));
    expect(await screen.findByText("denied")).toBeTruthy();
  });

  it("chooses one of the user's workspaces, then sets up this PC", async () => {
    const { user, hive } = renderApp({
      config: { ...noWorkspace, workspaces: [{ id: "ws-dev", name: "Dev" }] },
    });
    expect(await screen.findByRole("heading", { name: "Choose a workspace" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Dev/ }));
    expect(await screen.findByRole("heading", { name: "Set up this PC" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "PC name" }) as HTMLInputElement).value).toBe(
      "test-pc",
    );
    await user.click(screen.getByRole("button", { name: "Set up this PC" }));
    expect(await (await sidebar()).findByText("acme")).toBeTruthy();
    expect(hive.calls.setup).toEqual([
      { set: { workspaceId: "ws-dev" } },
      { register: { name: "test-pc" } },
    ]);
  });

  it("creates a workspace with a generated id when the user has none", async () => {
    const { user, hive } = renderApp({ config: noWorkspace });
    await user.type(await screen.findByRole("textbox", { name: "Workspace name" }), "My Team");
    await user.click(screen.getByRole("button", { name: "Create →" }));
    expect(await screen.findByRole("heading", { name: "Set up this PC" })).toBeTruthy();
    const [created] = hive.sent("workspace.create");
    expect(created!.command).toEqual({ type: "workspace.create", name: "My Team" });
    expect(created!.workspaceId).toMatch(/^my-team-[0-9a-f]{6}$/);
    expect(hive.calls.setup).toEqual([{ set: { workspaceId: created!.workspaceId } }]);
  });

  it("skips Set up this PC and opens the app", async () => {
    const { user, hive } = renderApp({ config: { deviceRegistered: false } });
    await user.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(await (await sidebar()).findByText("acme")).toBeTruthy();
    expect(hive.calls.setup).toEqual([]);
  });

  it("opens the account menu from the avatar; Settings opens Status", async () => {
    const { user } = renderApp();
    await user.click(await (await sidebar()).findByRole("button", { name: "Account" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual([
      "Settings",
      "Sign out",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Status" })).toBeTruthy();
  });

  it("confirms Sign out in a dialog: Cancel and Escape keep the session, Sign out logs out", async () => {
    const { user, hive } = renderApp();
    const openDialog = async () => {
      await user.click(await (await sidebar()).findByRole("button", { name: "Account" }));
      await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
      return screen.getByRole("dialog", { name: "Sign out?" });
    };
    const dialog = await openDialog();
    expect(dialog.textContent).toContain("hive executor uninstall");
    expect(document.activeElement?.textContent).toBe("Sign out");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await openDialog();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hive.calls.setup).toEqual([]);

    await openDialog();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in →" })).toBeTruthy();
    expect(hive.calls.setup).toEqual(["logout"]);
  });
});
