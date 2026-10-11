// Local Run data retention (docs/architecture.md §20.2, roadmap §6.1 "Local journal": short grace after the cloud ACK).
// Run once at executor start, before the journal is opened and the loop runs, so nothing appends meanwhile.
// A Run is pruned when its journal has a claim, its last `result` is not `stale_generation` (that one is still
// rechecked by reconcile), and an `uploaded` entry after that result is older than `maxAgeMs`. Its transcript, its
// `runs/<runId>` scratch dir and its journal lines are deleted. A Run without `uploaded` (pending, or `missing`, which
// the uploader skips) is never pruned. A session journal is deleted when no kept transcript names its session and it
// was last written before the cutoff; the cloud keeps the uploaded snapshot for `load`.
/* oxlint-disable no-await-in-loop */
import { open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { transcriptReader } from "./journal.ts";
import { sessionFileName, transcriptSessionIds } from "./sessionStore.ts";

const list = (dir: string) =>
  readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });

type Line = { text: string; entry: { kind?: string; runId?: string; state?: string; at?: string } };

export const pruneRunData = async (
  stateDir: string,
  { now = Date.now(), maxAgeMs = 30 * 24 * 60 * 60 * 1000 } = {},
) => {
  const cutoff = now - maxAgeMs;
  const path = join(stateDir, "journal.jsonl");
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  // A torn last line never completed (journal.ts); it is dropped like `readAll` does.
  const lines: Line[] = text.split("\n").flatMap((line) => {
    try {
      return line ? [{ text: line, entry: JSON.parse(line) as Line["entry"] }] : [];
    } catch {
      return [];
    }
  });

  const runs = new Map<string, { claimed: boolean; result?: string; uploadedAt?: number }>();
  for (const { entry } of lines) {
    if (!entry.runId) continue;
    const run = runs.get(entry.runId) ?? { claimed: false };
    runs.set(entry.runId, run);
    if (entry.kind === "claim") run.claimed = true;
    if (entry.kind === "result") {
      run.result = entry.state;
      delete run.uploadedAt;
    }
    if (entry.kind === "uploaded") run.uploadedAt = Date.parse(entry.at ?? "");
  }
  const pruned = new Set(
    [...runs].flatMap(([runId, run]) =>
      run.claimed &&
      run.result !== undefined &&
      run.result !== "stale_generation" &&
      run.uploadedAt !== undefined &&
      run.uploadedAt < cutoff
        ? [runId]
        : [],
    ),
  );

  // Sessions named by any transcript that stays, including transcripts the journal does not know.
  const read = transcriptReader(stateDir);
  const keptSessions = new Set<string>();
  for (const name of await list(join(stateDir, "transcripts"))) {
    const runId = name.replace(/\.jsonl$/, "");
    if (pruned.has(runId)) continue;
    const bytes = await read(runId);
    if (bytes) for (const id of transcriptSessionIds(bytes)) keptSessions.add(id);
  }

  for (const runId of pruned) {
    await rm(join(stateDir, "transcripts", `${runId}.jsonl`), { force: true });
    await rm(join(stateDir, "runs", runId), { recursive: true, force: true });
  }
  const sessions = [];
  for (const name of await list(join(stateDir, "sessions"))) {
    const match = sessionFileName.exec(name);
    if (!match || keptSessions.has(match[1]!)) continue;
    const file = join(stateDir, "sessions", name);
    if ((await stat(file)).mtimeMs >= cutoff) continue;
    await rm(file, { force: true });
    sessions.push(name);
  }

  // Compaction last: a crash before it leaves the lines, and the next start prunes the same Runs again.
  if (pruned.size > 0) {
    const temp = `${path}.tmp`;
    const file = await open(temp, "w");
    try {
      const kept = lines.filter((l) => !l.entry.runId || !pruned.has(l.entry.runId));
      await file.writeFile(kept.map((l) => `${l.text}\n`).join(""));
      await file.datasync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  }
  return { runs: [...pruned], sessions };
};
