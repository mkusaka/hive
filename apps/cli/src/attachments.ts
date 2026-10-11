import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import {
  type AttachmentSummary,
  allowedAttachmentContentTypes,
  maxAttachmentBytes,
} from "@hive/contracts";
import { type Client, invalid } from "./client.ts";

export type AttachmentTarget = {
  workspaceId: string;
  channelId?: string;
  conversationId?: string;
  threadOf?: string;
};

const contentTypes: Record<string, (typeof allowedAttachmentContentTypes)[number]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

/** Uploads a local supported file and returns its ready attachment metadata. */
export const uploadFile = async (
  client: Client,
  target: AttachmentTarget,
  path: string,
): Promise<AttachmentSummary> => {
  if (!target.workspaceId) throw invalid("workspaceId is required");
  if ((target.channelId === undefined) === (target.conversationId === undefined))
    throw invalid("exactly one of channelId / conversationId is required");
  const name = basename(path);
  const contentType = contentTypes[extname(name).toLowerCase()];
  if (!contentType || !allowedAttachmentContentTypes.includes(contentType))
    throw invalid(`unsupported attachment type: ${extname(name) || name}`);
  const info = await stat(path).catch(() => {
    throw invalid(`cannot read attachment: ${path}`);
  });
  if (!info.isFile()) throw invalid(`attachment is not a file: ${path}`);
  if (info.size > maxAttachmentBytes)
    throw invalid(`attachment exceeds the ${maxAttachmentBytes} byte limit`);
  const bytes = await readFile(path).catch(() => {
    throw invalid(`cannot read attachment: ${path}`);
  });
  if (bytes.byteLength > maxAttachmentBytes)
    throw invalid(`attachment exceeds the ${maxAttachmentBytes} byte limit`);
  const init = await client.post("/v1/attachments/init", {
    ...target,
    name,
    contentType,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  if (typeof init.id !== "string" || typeof init.uploadUrl !== "string")
    throw new Error("attachment init returned an invalid response");
  await client.putBytes(init.uploadUrl, bytes, contentType);
  const complete = await client.post(`/v1/attachments/${encodeURIComponent(init.id)}/complete`, {});
  return complete as AttachmentSummary;
};
