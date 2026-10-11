-- Hand-written (`drizzle-kit generate --custom`): drizzle has no FTS5 support (docs/architecture.md §14).
-- External-content FTS5 over search_documents (title, body) by rowid; the document table is the source, so the index
-- is rebuildable with `INSERT INTO search_fts(search_fts) VALUES ('rebuild')`. The triggers keep both in the same
-- statement, hence the same batch.
CREATE VIRTUAL TABLE `search_fts` USING fts5(title, body, content='search_documents', content_rowid='rowid', tokenize='trigram');
--> statement-breakpoint
CREATE TRIGGER `search_documents_ai` AFTER INSERT ON `search_documents` BEGIN
  INSERT INTO search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `search_documents_ad` AFTER DELETE ON `search_documents` BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
--> statement-breakpoint
CREATE TRIGGER `search_documents_au` AFTER UPDATE ON `search_documents` BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
