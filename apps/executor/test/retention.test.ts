/* oxlint-disable no-await-in-loop */
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fileJournal } from "../src/journal.ts";
import { pruneRunData } from "../src/retention.ts";

const day = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-12T00:00:00.000Z");
const old = new Date(now - 40 * day).toISOString();
const recent = new Date(now - 1 * day).toISOString();
const line = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;
const claim = (runId: string, at: string) =>
  line({ kind: "claim", runId, jobId: "j", executionGeneration: 1, inboxItemId: null, at });
const result = (runId: string, state: string, at: string) =>
  line({ kind: "result", runId, state, at });
const uploaded = (runId: string, at: string) =>
  line({ kind: "uploaded", runId, lastPartSeq: 0, at });
const init = (sessionId: string) =>
  line({ type: "system", subtype: "init", session_id: sessionId });

it("prunes only terminal, uploaded Runs past the cutoff and their unreferenced sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-retention-"));
  for (const sub of ["transcripts", "sessions", "runs/done-old"]) {
    await mkdir(join(dir, sub), { recursive: true });
  }
  const journal = [
    // Pruned: succeeded, uploaded 40 days ago.
    claim("done-old", old) + result("done-old", "succeeded", old) + uploaded("done-old", old),
    // Kept: uploaded recently.
    claim("done-new", old) + result("done-new", "succeeded", old) + uploaded("done-new", recent),
    // Kept: never uploaded (pending).
    claim("pending", old) + result("pending", "failed", old),
    // Kept: active (no result).
    claim("active", old),
    // Kept: unconfirmed stale generation, even though an upload happened.
    claim("stale", old) + result("stale", "stale_generation", old) + uploaded("stale", old),
    // Kept: resumed after an old upload, the newer result has no upload yet.
    claim("again", old) + result("again", "succeeded", old) + uploaded("again", old),
    result("again", "failed", recent),
  ].join("");
  await writeFile(join(dir, "journal.jsonl"), `${journal}{"kind":"cla`);
  const transcripts: Record<string, string> = {
    "done-old": init("s-pruned") + init("s-shared"),
    "done-new": init("s-shared"),
    pending: init("s-pending"),
    // Unknown to the journal: kept, and so are its sessions.
    orphan: init("s-orphan"),
  };
  for (const [runId, text] of Object.entries(transcripts)) {
    await writeFile(join(dir, "transcripts", `${runId}.jsonl`), text);
  }
  await writeFile(join(dir, "runs", "done-old", "scratch.txt"), "x");
  const sessions = ["s-pruned", "s-pruned.sub%2Fa", "s-shared", "s-pending", "s-orphan", "s-loose"];
  for (const id of sessions) await writeFile(join(dir, "sessions", `${id}.jsonl`), "{}\n");
  const oldTime = new Date(now - 40 * day);
  for (const id of sessions) await utimes(join(dir, "sessions", `${id}.jsonl`), oldTime, oldTime);
  // Recently written and unreferenced: kept by age.
  await writeFile(join(dir, "sessions", "s-fresh.jsonl"), "{}\n");

  expect(await pruneRunData(dir, { now })).toEqual({
    runs: ["done-old"],
    sessions: ["s-loose.jsonl", "s-pruned.jsonl", "s-pruned.sub%2Fa.jsonl"],
  });
  expect((await readdir(join(dir, "transcripts"))).toSorted()).toEqual([
    "done-new.jsonl",
    "orphan.jsonl",
    "pending.jsonl",
  ]);
  expect(await readdir(join(dir, "runs"))).toEqual([]);
  expect((await readdir(join(dir, "sessions"))).toSorted()).toEqual([
    "s-fresh.jsonl",
    "s-orphan.jsonl",
    "s-pending.jsonl",
    "s-shared.jsonl",
  ]);
  // The journal is compacted without the pruned Run (and the torn tail) and still reads back.
  const entries = await (await fileJournal(dir)).readAll();
  expect(entries.some((e) => e.runId === "done-old")).toBe(false);
  expect(entries).toHaveLength(13);
  expect((await readFile(join(dir, "journal.jsonl"), "utf8")).split("\n")).toHaveLength(14);

  // Idempotent: nothing more to prune.
  expect(await pruneRunData(dir, { now })).toEqual({ runs: [], sessions: [] });
});
