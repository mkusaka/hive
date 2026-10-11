import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext } from "@hive/contracts";
import { describe, expect, it } from "vitest";
import { downloadAttachments, withAttachments } from "../src/attachments.ts";
import { promptWithAttachments, userPrompt } from "../src/adapters/claude.ts";
import { createCloudClient } from "../src/cloudClient.ts";
import type { AgentAdapter, LaunchContext } from "../src/runner.ts";
import { context, fakeRunApi } from "./helpers.ts";

const stateDir = () => mkdtemp(join(tmpdir(), "hive-attachments-"));

describe("run attachments", () => {
  it("downloads safe, collision-free attachment paths before starting the adapter", async () => {
    const dir = await stateDir();
    const runContext: RunContext = {
      ...context,
      attachments: [
        {
          id: "attachment-1",
          name: "../notes.md",
          contentType: "text/markdown",
          size: 5,
          messageId: "message-1",
        },
        {
          id: "attachment-2",
          name: "notes.md",
          contentType: "text/markdown",
          size: 4,
          messageId: "message-2",
        },
      ],
    };
    const { api } = fakeRunApi();
    const downloads: string[] = [];
    api.getAttachment = async (id) => {
      downloads.push(id);
      return new TextEncoder().encode(id === "attachment-1" ? "first" : "last");
    };
    let received: LaunchContext | undefined;
    const inner: AgentAdapter = {
      start: async (ctx) => {
        received = ctx;
        return {
          requestStop: async () => {},
          waitForExit: async () => ({ code: 0, reason: "", summary: "" }),
        };
      },
    };

    await withAttachments(inner, { stateDir: dir }).start({
      runId: "run-1",
      jobId: "job-1",
      executionGeneration: 1,
      inboxItemId: "inbox-1",
      context: runContext,
      run: api,
      observe: async () => {},
    });

    expect(downloads).toEqual(["attachment-1", "attachment-2"]);
    expect(received?.context.attachments).toEqual([
      expect.objectContaining({ path: join(dir, "runs", "run-1", "attachments", "01-_notes.md") }),
      expect.objectContaining({ path: join(dir, "runs", "run-1", "attachments", "02-notes.md") }),
    ]);
    const paths = runContext.attachments.map((attachment) => attachment.path!);
    expect(paths.every((path) => path.startsWith(join(dir, "runs", "run-1", "attachments")))).toBe(
      true,
    );
    expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual([
      "first",
      "last",
    ]);
  });

  it("uses the Run capability, not the device token, for attachment bytes", async () => {
    const requests: { path: string; token: string | null }[] = [];
    const cloud = createCloudClient({
      apiUrl: "http://cloud.test",
      token: "device-secret",
      fetch: async (url, init) => {
        requests.push({ path: url.pathname, token: new Headers(init.headers).get("X-Hive-Token") });
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
    });

    await expect(cloud.forRun("capability-secret").getAttachment("id/with space")).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(requests).toEqual([
      { path: "/v1/run/attachments/id%2Fwith%20space", token: "capability-secret" },
    ]);
  });

  it("lists message-associated local files and supplies supported images to Claude", async () => {
    const dir = await stateDir();
    const runContext: RunContext = {
      ...context,
      attachments: [
        {
          id: "image-1",
          name: "diagram.png",
          contentType: "image/png",
          size: 3,
          messageId: "message-1",
        },
      ],
    };
    await downloadAttachments({
      context: runContext,
      runId: "run-1",
      run: {
        ...fakeRunApi().api,
        getAttachment: async () => new Uint8Array([1, 2, 3]),
      },
      stateDir: dir,
    });
    const imagePath = runContext.attachments[0]!.path!;
    const promptText = userPrompt(runContext);
    expect(promptText).toContain(
      JSON.stringify({
        messageId: "message-1",
        name: "diagram.png",
        contentType: "image/png",
        size: 3,
        path: imagePath,
      }),
    );
    const prompt = await promptWithAttachments(promptText, runContext.attachments);
    if (typeof prompt === "string") throw new Error("expected an image prompt");
    const message = (await prompt[Symbol.asyncIterator]().next()).value;
    expect(message.message.content).toEqual([
      { type: "text", text: promptText },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AQID" },
      },
    ]);
  });
});
