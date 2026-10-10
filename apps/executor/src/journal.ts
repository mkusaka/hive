// Local Journal file (docs/architecture.md §20.2): JSON lines under --state-dir, fsynced per entry.
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Journal, JournalEntry } from "./runner.ts";

export const fileJournal = async (stateDir: string): Promise<Journal> => {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "journal.jsonl");
  return {
    append: async (entry) => {
      const file = await open(path, "a");
      try {
        await file.appendFile(`${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
        await file.datasync();
      } finally {
        await file.close();
      }
    },
    readAll: async () => {
      const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      // A crash mid-append can leave a torn last line; it never completed, so it is skipped.
      return text.split("\n").flatMap((line) => {
        try {
          return line ? [JSON.parse(line) as JournalEntry] : [];
        } catch {
          return [];
        }
      });
    },
  };
};
