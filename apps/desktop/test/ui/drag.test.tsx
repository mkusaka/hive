// @vitest-environment happy-dom
/* oxlint-disable no-await-in-loop -- Panel tabs must be visited sequentially. */
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, sidebar } from "./fakeHive.ts";
import { dms } from "./fixtures.ts";

const expectBand = () => {
  const toggle = screen.getByRole("button", { name: "Toggle sidebar" });
  const band = toggle.closest(".window-drag");
  expect(band).toBeTruthy();
  expect(band?.classList.contains("window-drag")).toBe(true);
  expect(toggle.classList.contains("no-drag")).toBe(true);
  return toggle;
};

describe("window drag band", () => {
  it.each(["Threads", "Inbox", "Activity", "Audit", "Approvals", "Search", "Memory", "Status"])(
    "keeps the band and clickable toggle in %s, including the collapsed rail",
    async (label) => {
      const { user } = renderApp();
      const side = await sidebar();
      await user.click(side.getByRole("button", { name: label }));
      expect(screen.getByRole("heading", { name: new RegExp(`^${label}`) })).toBeTruthy();
      await user.click(expectBand());
      expect(
        screen
          .getByRole("button", { name: "Toggle sidebar" })
          .closest("aside")
          ?.classList.contains("collapsed"),
      ).toBe(true);
      await user.click(expectBand());
      expect(screen.getByPlaceholderText("Find a conversation…")).toBeTruthy();
    },
  );

  it("keeps the band across Channel, DM, and all Bot and Channel panel tabs", async () => {
    const { user } = renderApp({ get: { "/v1/dms": { dms } } });
    const side = await sidebar();
    await user.click(await side.findByRole("button", { name: /^# general Fixed/ }));
    expectBand();
    await user.click(screen.getByRole("button", { name: "# general" }));
    for (const tab of ["About", "Members", "Routines"]) {
      await user.click(screen.getByRole("tab", { name: tab }));
      expectBand();
    }
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(side.getByRole("button", { name: /coder dm ok/ }));
    expectBand();
    await user.click(
      within(screen.getByRole("main").querySelector("header")!).getByRole("button", {
        name: "coder",
      }),
    );
    for (const tab of ["Details", "Library", "Computer"]) {
      await user.click(screen.getByRole("tab", { name: tab }));
      expectBand();
    }
    expect(await screen.findByRole("heading", { name: "Executor on this PC" })).toBeTruthy();
  });

  it("keeps the band above the thread panel", async () => {
    const { user } = renderApp();
    const side = await sidebar();
    await user.click(await side.findByRole("button", { name: /^# general Fixed/ }));
    await user.click(screen.getAllByRole("button", { name: "Reply in thread" })[0]!);
    expect(
      within(screen.getByRole("complementary", { name: "Thread" })).getByText("Thread"),
    ).toBeTruthy();
    expectBand();
  });

  it("preserves the full-screen Welcome drag region", async () => {
    renderApp({ config: { apiUrl: "", workspaceId: "", deviceRegistered: false } });
    expect(
      (await screen.findByRole("button", { name: "Sign in →" })).closest(".welcome"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Toggle sidebar" })).toBeNull();
  });
});
