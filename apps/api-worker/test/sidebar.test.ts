// Per-user sidebar document (`sidebar.update`, `GET /v1/sidebar`, UI-04).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { envelope, type Json, withWorkspace } from "./helpers.ts";

const prefs = (pinned: string[]) => ({
  pinned: pinned.map((id) => ({ kind: "channel", id })),
  hidden: [{ kind: "bot", id: "b-1" }],
  groups: [{ name: "Work", items: [{ kind: "bot", id: "b-2" }] }],
});

describe("sidebar", () => {
  it("creates, updates with the revision, rejects a stale revision and writes a change row", async () => {
    const { user, workspaceId } = await withWorkspace();
    const read = async () =>
      (await user.get(`/v1/sidebar?workspaceId=${workspaceId}`)).json<Json>();
    const update = (p: unknown, expectedRevision: number) =>
      user.command(envelope(workspaceId, { type: "sidebar.update", prefs: p, expectedRevision }));

    expect(await read()).toEqual({
      workspaceName: "ws",
      prefs: { pinned: [], hidden: [], groups: [] },
      revision: 0,
    });
    const created = await update(prefs(["c-1"]), 0);
    expect(created.status).toBe(200);
    expect(await created.json<Json>()).toMatchObject({ revision: 1 });
    expect(await read()).toMatchObject({ prefs: prefs(["c-1"]), revision: 1 });

    // A second create (revision 0) and a stale update are both 409.
    expect((await update(prefs(["c-2"]), 0)).status).toBe(409);
    expect((await update(prefs(["c-2", "c-1"]), 1)).status).toBe(200);
    const stale = await update(prefs(["c-3"]), 1);
    expect(stale.status).toBe(409);
    expect(await stale.json<Json>()).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(await read()).toMatchObject({ prefs: prefs(["c-2", "c-1"]), revision: 2 });
    // Updating a document that does not exist yet is stale too.
    const other = await withWorkspace();
    expect(
      (
        await other.user.command(
          envelope(other.workspaceId, {
            type: "sidebar.update",
            prefs: prefs([]),
            expectedRevision: 3,
          }),
        )
      ).status,
    ).toBe(409);

    const change = await env.DB.prepare(
      "SELECT scope FROM change_log WHERE workspace_id = ? AND entity_kind = 'sidebar' ORDER BY seq DESC LIMIT 1",
    )
      .bind(workspaceId)
      .first<{ scope: string }>();
    expect(change?.scope).toBe(`workspace:${workspaceId}`);

    expect(
      (await update({ pinned: [{ kind: "task", id: "t" }], hidden: [], groups: [] }, 2)).status,
    ).toBe(422);
    const big = {
      ...prefs([]),
      pinned: Array.from({ length: 2000 }, () => ({ kind: "channel", id: "x".repeat(40) })),
    };
    expect((await update(big, 2)).status).toBe(422);
  });
});
