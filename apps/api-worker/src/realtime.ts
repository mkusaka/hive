// Realtime Durable Object (docs/architecture.md §12, ADR-04): one per Workspace, holds WebSocket connections
// only, never state. Messages are refetch hints; losing one never affects correctness.
import { DurableObject } from "cloudflare:workers";
import { headCursor } from "./sync.ts";

/** Computed by the Worker after authentication; stored on the socket (survives hibernation). */
export type Attachment = {
  principalKind: "user" | "device";
  principalId: string;
  scopes: string[];
};
export type Notification = { workspaceId: string; scopes: string[]; jobAvailable?: boolean };

/**
 * Set only by the Worker on `stub.fetch`. A DO is reachable only through its namespace binding, never from the
 * public internet, so the Worker-set header is the trust marker; the Worker never forwards client headers.
 */
export const principalHeader = "X-Hive-Principal";

/** The notification's scopes this socket may see; empty means do not send. */
export const visibleScopes = (socket: string[], changed: string[]) =>
  changed.filter((scope) => socket.includes(scope));

export class Realtime extends DurableObject {
  override async fetch(request: Request) {
    if (new URL(request.url).pathname === "/notify") {
      this.fanOut(await request.json<Notification & { cursor: string }>());
      return new Response(null, { status: 204 });
    }
    const principal = request.headers.get(principalHeader);
    if (!principal || request.headers.get("Upgrade") !== "websocket") {
      return new Response("forbidden", { status: 403 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    // ponytail: attachments are capped at 16 KiB (~350 channel scopes); keep only the principal and re-derive
    // scopes in the DO (D1 binding) when users join that many channels.
    server.serializeAttachment(JSON.parse(principal) as Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private fanOut({ workspaceId, scopes, cursor, jobAvailable }: Notification & { cursor: string }) {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment;
      const visible = visibleScopes(attachment.scopes, scopes);
      if (visible.length > 0) {
        ws.send(JSON.stringify({ type: "sync.changed", workspaceId, cursor, scopes: visible }));
      }
      if (jobAvailable && attachment.principalKind === "device") {
        ws.send(JSON.stringify({ type: "job.available", workspaceId }));
      }
    }
  }

  // Clients only receive; anything they send is ignored. No webSocketClose: since compatibility date
  // 2026-04-07 (`web_socket_auto_reply_to_close`) the runtime answers the close frame itself.
  override webSocketMessage() {}
}

/** Sends a hint to the Workspace's DO. Run via `waitUntil`; a failure is logged and dropped (§12.2). */
export const notify = async (
  env: { DB: D1Database; REALTIME: DurableObjectNamespace<Realtime> },
  notification: Notification,
) => {
  if (notification.scopes.length === 0 && !notification.jobAvailable) return;
  try {
    const cursor = await headCursor(env.DB, notification.workspaceId);
    const stub = env.REALTIME.get(env.REALTIME.idFromName(notification.workspaceId));
    await stub.fetch("https://realtime/notify", {
      method: "POST",
      body: JSON.stringify({ ...notification, cursor }),
    });
  } catch (error) {
    console.error("realtime notify failed", error);
  }
};
