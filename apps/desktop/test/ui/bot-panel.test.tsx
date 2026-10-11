// @vitest-environment happy-dom
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, sidebar } from "./fakeHive.ts";

/** Opens coder's panel from its sidebar blob. */
const openCoder = async () => {
  const app = renderApp();
  await app.user.click(await (await sidebar()).findByRole("button", { name: "coder" }));
  const panel = within(app.container.querySelector<HTMLElement>(".panel")!);
  return { ...app, panel };
};

describe("bot panel", () => {
  it("opens on the blob with instructions, tool policy and its routines", async () => {
    const { panel, hive } = await openCoder();
    expect(panel.getByRole("heading", { name: "coder" })).toBeTruthy();
    expect(panel.getByText("Write small diffs.")).toBeTruthy();
    expect(panel.getByText(/"bash": "ask"/)).toBeTruthy();
    expect(await panel.findByText("Daily digest")).toBeTruthy();
    expect(panel.getByText("Weekdays at 9:00 AM")).toBeTruthy();
    expect(panel.getByText("# general")).toBeTruthy();
    expect(hive.calls.get).toContain("/v1/routines?workspaceId=ws-1&botId=bot-1");
  });

  it("pauses and deletes a routine from its menu", async () => {
    const { panel, user, hive } = await openCoder();
    await user.click(await panel.findByRole("button", { name: "Daily digest actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Pause" }));
    await user.click(panel.getByRole("button", { name: "Daily digest actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(hive.calls.command.map((e) => e.command)).toEqual([
      { type: "routine.pause", routineId: "rt-1" },
      { type: "routine.delete", routineId: "rt-1" },
    ]);
  });

  it("lists the bot's memories in Library", async () => {
    const { panel, user, hive } = await openCoder();
    await user.click(panel.getByRole("tab", { name: "Library" }));
    expect(await panel.findByText("prefers bun")).toBeTruthy();
    expect(hive.calls.get).toContain("/v1/memories?workspaceId=ws-1&scopeKind=bot&scopeId=bot-1");
  });

  it("shows the executor service in Computer and starts it with the chosen provider", async () => {
    const { panel, user, hive } = await openCoder();
    await user.click(panel.getByRole("tab", { name: "Computer" }));
    expect(await panel.findByText("loaded, pid 4242")).toBeTruthy();
    expect(panel.getByText("studio")).toBeTruthy();
    expect(panel.getByText("online")).toBeTruthy();
    await user.selectOptions(panel.getByRole("combobox", { name: "Provider" }), "codex");
    await user.click(panel.getByRole("button", { name: "Start" }));
    expect(hive.calls.executor).toEqual([{ start: { provider: "codex", concurrency: 1 } }]);
  });
});
