// Claude SessionStore (docs/architecture.md §13.3). `append` writes each entry as a JSON line to a hive-owned journal
// `<state-dir>/sessions/<sessionId>[.<subpath, URI-encoded, dots too>].jsonl` and fsyncs; it never touches the network. The
// uploader mirrors the journals of a Run to the cloud after the Run (uploader.ts). `load` reads the local journal, or
// else fetches the newest complete cloud snapshot and writes it locally first. Entries are pass-through blobs.
// Keyed by sessionId + subpath only: the SDK derives `projectKey` from the cwd, a per-run scratch dir in hive.
// listSessions / listSessionSummaries / delete / listSubkeys are not implemented: a resume with an explicit `resume`
// id needs only `load`, and without `listSubkeys` the SDK materializes the main transcript only.
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { SessionStreamKey } from "@hive/contracts";
import type { CloudClient } from "./cloudClient.ts";
import { transcriptReader } from "./journal.ts";

const fileName = ({ sessionId, subpath }: SessionStreamKey) => {
  // The SDK only uses UUIDs; anything else must not become a path.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error(`invalid session id ${sessionId}`);
  return `${sessionId}${subpath ? `.${encodeURIComponent(subpath).replaceAll(".", "%2E")}` : ""}.jsonl`;
};

const readText = (path: string) =>
  readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

// A torn last line never completed; skip it like the Local Journal does.
const parse = (text: string) =>
  text.split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as SessionStoreEntry] : [];
    } catch {
      return [];
    }
  });

const write = async (path: string, flag: "a" | "wx", text: string | Uint8Array) => {
  const file = await open(path, flag);
  try {
    await file.writeFile(text);
    await file.datasync();
  } finally {
    await file.close();
  }
};

export const sessionStore = ({
  stateDir,
  cloud,
}: {
  stateDir: string;
  cloud: Pick<CloudClient, "getSessionSnapshot">;
}): SessionStore => {
  const dir = join(stateDir, "sessions");
  // Per journal: the tail of its append chain, and the uuids it holds (read once, on first use).
  const chains = new Map<string, Promise<void>>();
  const seen = new Map<string, Set<string>>();

  return {
    append: (key: SessionKey, entries: SessionStoreEntry[]) => {
      const path = join(dir, fileName(key));
      const next = (chains.get(path) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          let uuids = seen.get(path);
          if (!uuids) {
            const text = await readText(path);
            uuids = new Set(parse(text ?? "").flatMap((e) => (e.uuid ? [e.uuid] : [])));
            seen.set(path, uuids);
          }
          // Keep the first of each uuid, in order; entries without one are never deduped.
          const added = new Set<string>();
          const fresh = entries.filter((e) => {
            if (!e.uuid) return true;
            if (uuids.has(e.uuid) || added.has(e.uuid)) return false;
            added.add(e.uuid);
            return true;
          });
          if (fresh.length === 0) return;
          await mkdir(dir, { recursive: true });
          await write(path, "a", fresh.map((e) => `${JSON.stringify(e)}\n`).join(""));
          // Only once durable: a failed write is retried by the SDK and must not be deduped away.
          for (const uuid of added) uuids.add(uuid);
        });
      chains.set(path, next);
      return next;
    },
    load: async (key: SessionKey) => {
      const path = join(dir, fileName(key));
      await chains.get(path)?.catch(() => {});
      const local = await readText(path);
      if (local !== null) return parse(local);
      const bytes = await cloud.getSessionSnapshot("claude", {
        sessionId: key.sessionId,
        ...(key.subpath ? { subpath: key.subpath } : {}),
      });
      if (!bytes) return null;
      await mkdir(dir, { recursive: true });
      await write(path, "wx", bytes);
      return parse(new TextDecoder().decode(bytes));
    },
  };
};

/** The session ids a Run transcript's `system/init` messages name. */
export const transcriptSessionIds = (bytes: Uint8Array) =>
  new Set(
    parse(new TextDecoder().decode(bytes)).flatMap((m) =>
      m.type === "system" && m.subtype === "init" && typeof m.session_id === "string"
        ? [m.session_id]
        : [],
    ),
  );

/** `<sessionId>[.<subpath>].jsonl`: the file name `sessionStore` writes. */
export const sessionFileName = /^([A-Za-z0-9_-]+)(?:\.([^.]+))?\.jsonl$/;

/**
 * The session journals a Run used: every session its transcript's `system/init` names, main and sub-agent files.
 * What the uploader mirrors after the Run.
 */
export const sessionJournals = (stateDir: string) => {
  const transcript = transcriptReader(stateDir);
  const dir = join(stateDir, "sessions");
  return async (runId: string) => {
    const bytes = await transcript(runId);
    if (!bytes) return [];
    const ids = transcriptSessionIds(bytes);
    const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const journals = [];
    for (const name of files.toSorted()) {
      const match = sessionFileName.exec(name);
      if (!match || !ids.has(match[1]!)) continue;
      const session: SessionStreamKey = {
        sessionId: match[1]!,
        ...(match[2] ? { subpath: decodeURIComponent(match[2]) } : {}),
      };
      // oxlint-disable-next-line no-await-in-loop
      journals.push({ session, bytes: new Uint8Array(await readFile(join(dir, name))) });
    }
    return journals;
  };
};
