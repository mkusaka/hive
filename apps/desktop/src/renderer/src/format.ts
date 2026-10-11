// Pure formatting for the chat UI: a small safe Markdown subset (as data, rendered by React without HTML), Routine
// schedule lines and avatar colors.
import type { FilterExpression } from "@hive/contracts";
import type { JSONContent } from "@tiptap/core";

/** The mention id of `<@everyone>`: every member Bot of the Channel (ROUTE-02). */
export const everyone = "everyone";

export type Inline =
  | { kind: "text" | "bold" | "italic" | "code"; text: string }
  | { kind: "link"; text: string; url: string }
  /** A `<@bot:ID>` token (contracts `mentionToken`); the view shows the Bot's name. `<@everyone>` has id `everyone`. */
  | { kind: "mention"; id: string };
export type Block =
  | { kind: "p"; inlines: Inline[] }
  | { kind: "ul" | "ol"; items: Inline[][] }
  | { kind: "code"; text: string };

const inlinePattern =
  /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|<@bot:([^>\s]+)>|<@(everyone)>|(?<!\w)_([^_\n]+)_(?!\w)/g;

/** `**bold**`, `_italic_`, `` `code` ``, `[text](url)` and mention tokens; everything else is text. */
export const parseInline = (text: string): Inline[] => {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(inlinePattern)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "bold", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "code", text: m[2] });
    else if (m[5] !== undefined || m[6] !== undefined)
      out.push({ kind: "mention", id: (m[5] ?? m[6])! });
    else if (m[7] !== undefined) out.push({ kind: "italic", text: m[7] });
    else out.push({ kind: "link", text: m[3]!, url: m[4]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
};

const bullet = /^\s*[-*]\s+(.*)$/;
const numbered = /^\s*\d+[.)]\s+(.*)$/;

/** Paragraphs (lines kept), `-` / `*` and numbered lists, fenced code blocks (an unclosed fence runs to the end). */
export const parseMarkdown = (source: string): Block[] => {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith("```"); i++)
        code.push(lines[i]!);
      i++;
      blocks.push({ kind: "code", text: code.join("\n") });
    } else if (bullet.test(line) || numbered.test(line)) {
      const pattern = bullet.test(line) ? bullet : numbered;
      const items: Inline[][] = [];
      for (; i < lines.length && pattern.test(lines[i]!); i++)
        items.push(parseInline(pattern.exec(lines[i]!)![1]!));
      blocks.push({ kind: pattern === bullet ? "ul" : "ol", items });
    } else if (line.trim() === "") i++;
    else {
      const para: string[] = [];
      for (
        ;
        i < lines.length &&
        lines[i]!.trim() !== "" &&
        !lines[i]!.trimStart().startsWith("```") &&
        !bullet.test(lines[i]!) &&
        !numbered.test(lines[i]!);
        i++
      )
        para.push(lines[i]!);
      blocks.push({ kind: "p", inlines: parseInline(para.join("\n")) });
    }
  }
  return blocks;
};

const marks: Record<string, string> = { bold: "**", italic: "_", code: "`" };

const inlineMarkdown = (nodes: JSONContent[] = []) =>
  nodes
    .map((n) => {
      if (n.type === "mention")
        return n.attrs?.id === everyone ? "<@everyone>" : `<@bot:${String(n.attrs?.id)}>`;
      if (n.type === "hardBreak") return "\n";
      return (n.marks ?? []).reduce((out, m) => {
        const wrap = marks[m.type];
        return wrap ? `${wrap}${out}${wrap}` : out;
      }, n.text ?? "");
    })
    .join("");

const blockMarkdown = (n: JSONContent): string => {
  if (n.type === "codeBlock")
    return `\`\`\`${String(n.attrs?.language ?? "")}\n${inlineMarkdown(n.content)}\n\`\`\``;
  if (n.type === "bulletList" || n.type === "orderedList")
    return (n.content ?? [])
      .map((item, i) => {
        const marker = n.type === "bulletList" ? "- " : `${Number(n.attrs?.start ?? 1) + i}. `;
        return marker + (item.content ?? []).map(blockMarkdown).join("\n").replaceAll("\n", "\n  ");
      })
      .join("\n");
  return inlineMarkdown(n.content);
};

/**
 * The composer's editor document as a message body: mention nodes as `<@bot:ID>` tokens, hard breaks as newlines,
 * bold / italic / code marks, lists and fenced code blocks as the Markdown subset above; one block per line (an
 * empty paragraph is a blank line), so Shift+Enter lines arrive as typed.
 */
export const toMarkdown = (doc: JSONContent) =>
  (doc.content ?? []).map(blockMarkdown).join("\n").trim();

export type Schedule =
  | { kind: "cron"; expr: string; timezone: string }
  | { kind: "once"; at: string }
  | { kind: "webhook" }
  | { kind: "event"; filter: FilterExpression };

const int = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);
const clock = (hour: number, minute: number) =>
  `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;

/**
 * A human line for the common cron shapes (weekdays / daily at a time, every N minutes, hourly at a minute; times in
 * the Routine's own zone), else the raw expression; `once` in `timeZone` (default: this machine's).
 */
const eventTypePrefix = (filter: FilterExpression): string | undefined => {
  if (
    (filter.op === "prefix" || filter.op === "eq") &&
    filter.field === "type" &&
    typeof filter.value === "string"
  )
    return filter.value;
  if (filter.op === "and") {
    for (const node of filter.nodes) {
      const type = eventTypePrefix(node);
      if (type) return type;
    }
  }
  return undefined;
};

export const scheduleLine = (schedule: Schedule, timeZone?: string) => {
  if (schedule.kind === "webhook") return "When a webhook fires";
  if (schedule.kind === "event") {
    const type = eventTypePrefix(schedule.filter);
    return type ? `When ${type} events match` : "When events match";
  }
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    const date = at.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone });
    const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
    return `Once ${date} at ${time}`;
  }
  const [min, hour, dom, mon, dow] = schedule.expr.trim().split(/\s+/);
  const m = int(min);
  const h = int(hour);
  if (dom === "*" && mon === "*" && m !== null && h !== null) {
    if (dow === "1-5") return `Weekdays at ${clock(h, m)}`;
    if (dow === "*") return `Daily at ${clock(h, m)}`;
  }
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const every = /^\*\/(\d+)$/.exec(min ?? "");
    if (every) return `Every ${every[1]} minutes`;
    if (m !== null) return `Every hour at :${String(m).padStart(2, "0")}`;
  }
  return schedule.expr;
};

/** A stable hue from the id, so a Bot keeps its color everywhere. */
export const avatarColor = (id: string) => {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 62% 58%)`;
};
