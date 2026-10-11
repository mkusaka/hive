import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { claim, executor, queuedJob, setup } from "./helpers.ts";
import { indexSource } from "../src/search.ts";

const migrationStatements: string[] = [];
for (const statement of env.COLLECT_MIGRATION.split("--> statement-breakpoint")) {
  const trimmed = statement.trim();
  if (trimmed.length > 0) migrationStatements.push(trimmed);
}

describe("migration 0031 (collector, formerly 0027)", () => {
  it("rebuilds populated runs without losing Execution, capability, or transcript references", async () => {
    const s = await setup();
    const { jobId } = await queuedJob(s);
    const claimed = await (
      await executor(s.deviceToken, s.workspaceId).command(claim(jobId))
    ).json<{ runId: string }>();
    await env.DB.prepare(
      "INSERT INTO transcript_streams (id, workspace_id, run_id, provider) VALUES (?, ?, ?, 'claude')",
    )
      .bind(crypto.randomUUID(), s.workspaceId, claimed.runId)
      .run();
    await s.ok({ type: "project.create", key: "APP", name: "app" });
    const { taskId } = await s.ok({
      type: "task.create",
      projectKey: "APP",
      title: "Migration needle",
    });
    await indexSource(env.DB, { sourceKind: "task", sourceId: String(taskId) });

    const statements: D1PreparedStatement[] = [];
    for (const statement of migrationStatements) statements.push(env.DB.prepare(statement));
    await env.DB.batch(statements);
    expect(
      await env.DB.prepare(
        `SELECT r.kind, (SELECT COUNT(*) FROM executions e WHERE e.run_id = r.id) AS executions,
                  (SELECT COUNT(*) FROM run_capabilities c WHERE c.run_id = r.id) AS capabilities,
                  (SELECT COUNT(*) FROM transcript_streams s WHERE s.run_id = r.id) AS streams
             FROM runs r WHERE r.id = ?`,
      )
        .bind(claimed.runId)
        .first(),
    ).toEqual({ kind: "job", executions: 1, capabilities: 1, streams: 1 });
    const search = async (q: string) =>
      (await s.user.get(`/v1/search?workspaceId=${s.workspaceId}&q=${q}&kinds=task`)).json();
    expect(await search("Migration")).toMatchObject({
      hits: [{ sourceKind: "task", sourceId: taskId }],
    });
    await env.DB.prepare(
      "UPDATE tasks SET title = 'Replacement needle', revision = revision + 1 WHERE id = ?",
    )
      .bind(taskId)
      .run();
    await indexSource(env.DB, { sourceKind: "task", sourceId: String(taskId) });
    expect(await search("Migration")).toMatchObject({ hits: [] });
    expect(await search("Replacement")).toMatchObject({
      hits: [{ sourceKind: "task", sourceId: taskId }],
    });
  });
});
