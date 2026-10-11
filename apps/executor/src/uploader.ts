// Transcript uploader (docs/architecture.md §3.3, §13.3; AT-21). After a Run's result is journaled, its local JSONL
// transcript is split into parts, each sent as init → PUT → (cloud verifies and commits the manifest), then
// `complete` with the last part seq. `uploaded` is journaled only after that ACK, never before. The local file is
// kept (no retention sweep yet). Web-standard APIs only: the file read is injected.
// The Run's native session journals (sessionStore.ts, §13.3) go the same way, each as a full snapshot stream of that
// Run, before `uploaded`. ponytail: every resume re-uploads the whole session (O(n²) bytes over many resumes); upload
// only the tail as a delta stream if that bites. Eager per-batch upload during the Run is not done.
/* oxlint-disable no-await-in-loop */
import type { SessionStreamKey } from "@hive/contracts";
import type { CloudClient } from "./cloudClient.ts";
import type { Journal } from "./runner.ts";

export const partBytes = 1024 * 1024;

type Bytes = Uint8Array<ArrayBuffer>;

/** Parts of ≤ `maxBytes` split after a newline; a single longer line is a part of its own. */
export const splitParts = (bytes: Bytes, maxBytes = partBytes) => {
  const parts: Bytes[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length);
    if (end < bytes.length) {
      const newline = bytes.lastIndexOf(10, end - 1);
      end = newline >= start ? newline + 1 : bytes.indexOf(10, end) + 1 || bytes.length;
    }
    parts.push(bytes.subarray(start, end));
    start = end;
  }
  return parts;
};

const sha256 = async (bytes: Bytes) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/**
 * Uploads every part (a part the cloud already committed is skipped) and completes; returns the last part seq
 * (-1 for an empty transcript). Safe to repeat from the start: the split is deterministic and init is idempotent.
 */
export const uploadTranscript = async (
  cloud: CloudClient,
  runId: string,
  bytes: Bytes,
  provider: string,
  session?: SessionStreamKey,
) => {
  const parts = splitParts(bytes);
  for (const [partSeq, part] of parts.entries()) {
    const { uploadId, committed } = await cloud.uploadInit({
      runId,
      partSeq,
      byteSize: part.length,
      sha256: await sha256(part),
      provider,
      ...(session ? { session } : {}),
    });
    if (!committed) await cloud.uploadPart(uploadId, part);
  }
  const lastPartSeq = parts.length - 1;
  await cloud.uploadComplete({ runId, lastPartSeq, ...(session ? { session } : {}) });
  return lastPartSeq;
};

export type Uploader = ReturnType<typeof transcriptUploader>;

/**
 * `upload(runId)`: up to `attempts` tries with doubling backoff; on failure the Run stays `persistence=pending` and
 * the next start retries it (`pending`). Never throws. `read` returns the transcript bytes, null when there is none.
 */
export const transcriptUploader = ({
  cloud,
  journal,
  read,
  sessions = async () => [],
  provider,
  attempts = 3,
  backoffMs = 1000,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  cloud: CloudClient;
  journal: Journal;
  read(runId: string): Promise<Bytes | null>;
  /** The Run's native session journals; none by default. */
  sessions?(runId: string): Promise<{ session: SessionStreamKey; bytes: Bytes }[]>;
  provider: string;
  attempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}) => {
  const upload = async (runId: string) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const bytes = (await read(runId)) ?? new Uint8Array();
        const lastPartSeq = await uploadTranscript(cloud, runId, bytes, provider);
        for (const s of await sessions(runId)) {
          if (s.bytes.length > 0)
            await uploadTranscript(cloud, runId, s.bytes, provider, s.session);
        }
        await journal.append({ kind: "uploaded", runId, lastPartSeq });
        return true;
      } catch (error) {
        if (attempt >= attempts) {
          console.error(`transcript upload of ${runId} failed; persistence stays pending`, error);
          return false;
        }
        await sleep(backoffMs * 2 ** (attempt - 1));
      }
    }
  };
  return {
    upload,
    /** Every Run with a result but no `uploaded` marker; a Run the cloud does not know (`missing`) is skipped. */
    pending: async () => {
      const entries = await journal.readAll();
      const uploaded = new Set(entries.flatMap((e) => (e.kind === "uploaded" ? [e.runId] : [])));
      const finished = new Set(
        entries.flatMap((e) => (e.kind === "result" && e.state !== "missing" ? [e.runId] : [])),
      );
      for (const runId of finished) if (!uploaded.has(runId)) await upload(runId);
    },
  };
};
