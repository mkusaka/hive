import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const db = env.DB;

// G-06 on miniflare only: FTS5 trigram, external content and the sync triggers of `0012_search_fts`.
describe("search_fts", () => {
  it("indexes through the triggers and matches Japanese substrings; update and delete follow", async () => {
    const ws = crypto.randomUUID();
    const source = crypto.randomUUID();
    await db.batch([
      db.prepare("INSERT INTO workspaces (id, name) VALUES (?, 'ws')").bind(ws),
      db
        .prepare(
          `INSERT INTO search_documents (workspace_id, source_kind, source_id, source_revision, chunk_key, title, body,
             scope, indexed_at) VALUES (?, 'message', ?, 1, '0', '', 'レビューコメントを確認して', ?, '')`,
        )
        .bind(ws, source, `workspace:${ws}`),
    ]);
    const match = (q: string) =>
      db
        .prepare(
          `SELECT d.source_id FROM search_fts JOIN search_documents d ON d.rowid = search_fts.rowid
            WHERE search_fts MATCH ? AND d.workspace_id = ?`,
        )
        .bind(q, ws)
        .all<{ source_id: string }>()
        .then((r) => r.results.map((x) => x.source_id));

    expect(await match('"レビュー"')).toEqual([source]);
    expect(await match('"コメントを確認"')).toEqual([source]);
    expect(await match('"承認"')).toEqual([]);

    await db
      .prepare("UPDATE search_documents SET body = 'approve the deploy' WHERE source_id = ?")
      .bind(source)
      .run();
    expect(await match('"レビュー"')).toEqual([]);
    expect(await match('"deploy"')).toEqual([source]);

    await db.prepare("DELETE FROM search_documents WHERE source_id = ?").bind(source).run();
    expect(await match('"deploy"')).toEqual([]);
  });
});
