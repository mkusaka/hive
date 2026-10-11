import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunContext } from "@hive/contracts";
import type { RunApi } from "./cloudClient.ts";
import type { AgentAdapter } from "./runner.ts";

type Attachment = RunContext["attachments"][number];

const attachmentFilename = (attachment: Attachment, index: number) => {
  const name = attachment.name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120);
  return `${String(index + 1).padStart(2, "0")}-${name || "attachment"}`;
};

/**
 * Downloads every attachment with the Run capability before an adapter builds its prompt. The local filename is
 * deterministic, traversal-free and unique within the Run; a resumed Run without a capability may reuse complete
 * downloads from its earlier attempt.
 */
export const downloadAttachments = async ({
  context,
  runId,
  run,
  stateDir,
}: {
  context: RunContext;
  runId: string;
  run: RunApi | null;
  stateDir: string;
}) => {
  const dir = join(stateDir, "runs", runId, "attachments");
  await mkdir(dir, { recursive: true });
  const attachments = await Promise.all(
    context.attachments.map(async (attachment, index) => {
      const path = join(dir, attachmentFilename(attachment, index));
      if (!run) {
        if ((await stat(path).catch(() => null))?.size !== attachment.size) {
          throw new Error(`attachment ${attachment.id} is unavailable without a Run capability`);
        }
      } else {
        const bytes = await run.getAttachment(attachment.id);
        if (bytes.byteLength !== attachment.size) {
          throw new Error(`attachment ${attachment.id} size mismatch`);
        }
        const temporary = `${path}.download`;
        await writeFile(temporary, bytes);
        await rename(temporary, path);
      }
      return { ...attachment, path };
    }),
  );
  context.attachments = attachments;
};

/** Ensures adapters receive local attachment paths and never the Run capability itself. */
export const withAttachments = (
  inner: AgentAdapter,
  { stateDir }: { stateDir: string },
): AgentAdapter => ({
  start: async (ctx) => {
    await downloadAttachments({ context: ctx.context, runId: ctx.runId, run: ctx.run, stateDir });
    return inner.start(ctx);
  },
});
