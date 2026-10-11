import type { SidebarPrefs } from "@hive/contracts";

export type Row = Record<string, unknown> & { id: string };
export type Conversation = {
  kind: "channel" | "dm" | "thread";
  id: string;
  title: string;
  botId?: string;
  threadOf?: string;
  parent?: Conversation;
};
export type Screen =
  | { kind: "channels" | "approvals" | "activity" | "search" | "settings" | "tasks" }
  | { kind: "conversation"; conversation: Conversation }
  | { kind: "detail"; resource: "jobs" | "tasks" | "runs"; id: string };
export type ConversationItem = { key: string; conversation: Conversation; preview: string };

export const conversationSections = (
  channels: Row[],
  dms: Row[],
  prefs: SidebarPrefs,
  bots: Row[] = [],
) => {
  const items = [
    ...channels.map((row): ConversationItem => ({
      key: `channel:${row.id}`,
      conversation: { kind: "channel", id: row.id, title: `#${String(row.name)}` },
      preview: preview(row),
    })),
    ...dms.map((row): ConversationItem => ({
      key: `dm:${row.id}`,
      conversation: { kind: "dm", id: row.id, title: String(row.name), botId: String(row.botId) },
      preview: preview(row),
    })),
    ...bots.map((row): ConversationItem => ({
      key: `bot:${row.id}`,
      conversation: { kind: "dm", id: row.id, title: String(row.name), botId: row.id },
      preview: "Start a direct message",
    })),
  ];
  const hidden = new Set(prefs.hidden.map((item) => `${item.kind}:${item.id}`));
  const pinned = prefs.pinned.map((item) => `${item.kind}:${item.id}`);
  const visible = items.filter((item) => !hidden.has(item.key));
  const used = new Set<string>();
  const take = (keys: string[]) =>
    keys.flatMap((key) => {
      const item = visible.find((entry) => entry.key === key);
      if (!item || used.has(key)) return [];
      used.add(key);
      return [item];
    });
  const sections = [
    { title: "Starred", items: take(pinned) },
    ...prefs.groups.map((group) => ({
      title: group.name,
      items: take(group.items.map((item) => `${item.kind}:${item.id}`)),
    })),
  ];
  sections.push(
    {
      title: "Channels",
      items: visible.filter((item) => !used.has(item.key) && item.conversation.kind === "channel"),
    },
    {
      title: "Direct messages",
      items: visible.filter((item) => !used.has(item.key) && item.key.startsWith("dm:")),
    },
    {
      title: "Bots",
      items: visible.filter((item) => !used.has(item.key) && item.key.startsWith("bot:")),
    },
  );
  return sections;
};

const preview = (row: Row) => {
  const message = row.lastMessage;
  return message && typeof message === "object" && "body" in message
    ? String(message.body)
    : "No messages yet";
};
export const mentionSuggestions = (draft: string, bots: Row[], conversation: Conversation) => {
  const query = /(?:^|\s)@([^\s@<>]*)$/.exec(draft)?.[1];
  if (query === undefined) return [];
  return bots
    .filter(
      (bot) =>
        (!conversation.botId || bot.id === conversation.botId) &&
        String(bot.name).toLowerCase().startsWith(query.toLowerCase()),
    )
    .slice(0, 8);
};
export const insertMention = (draft: string, botId: string) =>
  draft.replace(/@[^\s@<>]*$/, `<@bot:${botId}> `);
export const postMessage = (conversation: Conversation, text: string) => ({
  type: "message.post",
  ...(conversation.kind === "channel"
    ? { channelId: conversation.id }
    : { conversationId: conversation.id }),
  ...(conversation.threadOf ? { threadOf: conversation.threadOf } : {}),
  text: text.trim(),
});
export const notificationTarget = (
  value: unknown,
): { kind: "approval" | "mention" | "job"; id: string } | null => {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (
    !(["approval", "mention", "job"] as unknown[]).includes(data.kind) ||
    typeof data.id !== "string" ||
    !data.id ||
    Object.keys(data).some((key) => key !== "kind" && key !== "id")
  )
    return null;
  return { kind: data.kind as "approval" | "mention" | "job", id: data.id };
};
