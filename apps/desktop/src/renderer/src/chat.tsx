// The Channel conversation: header (star, name pill, topic, member count, "…"), day sections with sticky date pills, Markdown bubbles and the composer (message.post with @mentions).
/* oxlint-disable no-await-in-loop */
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type Inline, parseMarkdown } from "./format.ts";
import { Avatar, Icon, type Row, text } from "./ui.tsx";

/** Bot id → name, for mention tokens. */
export type Names = ReadonlyMap<string, string>;

export const Inlines = ({ inlines, names }: { inlines: Inline[]; names: Names }) =>
  inlines.map((part, i) =>
    part.kind === "mention" ? (
      <span key={i} className="mention">
        @{names.get(part.id) ?? "unknown"}
      </span>
    ) : part.kind === "bold" ? (
      <strong key={i}>{part.text}</strong>
    ) : part.kind === "code" ? (
      <code key={i}>{part.text}</code>
    ) : part.kind === "link" ? (
      // Text + URL: the window denies opening links.
      <span key={i} className="link">
        {part.text} <span className="url">({part.url})</span>
      </span>
    ) : (
      <Fragment key={i}>{part.text}</Fragment>
    ),
  );

/** The parsed subset as React elements: no HTML is ever injected. */
export const Markdown = ({ source, names }: { source: string; names: Names }) =>
  parseMarkdown(source).map((block, i) => {
    if (block.kind === "code") return <pre key={i}>{block.text}</pre>;
    if (block.kind === "p")
      return (
        <p key={i}>
          <Inlines inlines={block.inlines} names={names} />
        </p>
      );
    const List = block.kind;
    return (
      <List key={i}>
        {block.items.map((item, j) => (
          <li key={j}>
            <Inlines inlines={item} names={names} />
          </li>
        ))}
      </List>
    );
  });

/** The day pill: Today, Yesterday, or the weekday and date (with the year when it is not this year). */
export const dayLabel = (at: Date, now = new Date()) => {
  const days = Math.round(
    (new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return at.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
};

/** Messages (oldest first) split into days: each day is a section whose pill sticks while it scrolls. */
const byDay = (messages: Row[]) => {
  const days: { day: string; at: Date; messages: Row[] }[] = [];
  for (const m of messages) {
    const at = new Date(String(m.createdAt));
    const day = at.toDateString();
    if (days.at(-1)?.day !== day) days.push({ day, at, messages: [] });
    days.at(-1)!.messages.push(m);
  }
  return days;
};

/** `jobIds`: null while routing is pending, then one per mentioned Bot (empty: nobody was mentioned). */
type Operation = { operationId: string; jobIds: string[] | null; error?: string };

const escapeRegExp = (s: string) => s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `@name` → `<@bot:ID>` for the names picked from the popup, longest first. */
const withTokens = (draft: string, picked: Names) =>
  [...picked]
    .toSorted(([a], [b]) => b.length - a.length)
    .reduce(
      (out, [name, id]) =>
        out.replaceAll(new RegExp(`@${escapeRegExp(name)}(?![\\w-])`, "g"), `<@bot:${id}>`),
      draft,
    );

export const ChannelView = (props: {
  ws: string;
  channel: Row | undefined;
  messages: Row[];
  bots: Row[];
  me: string | null;
  openBot: (id: string) => void;
  toggleChannelPanel: () => void;
  /** The header's member count (Members) and "…" (About). */
  openChannelPanel: (tab: "about" | "members") => void;
  starred: boolean;
  toggleStar: () => void;
}) => {
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  /** The draft at the last Esc: the popup stays closed until the draft changes. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const picked = useRef(new Map<string, string>());
  const box = useRef<HTMLTextAreaElement>(null);
  const nextCaret = useRef<number | null>(null);
  const [op, setOp] = useState<Operation | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (nextCaret.current === null) return;
    box.current?.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = null;
  });
  // Braces: Chromium's scrollIntoView returns a Promise, which React would call as the cleanup.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: "end" });
  }, [props.messages]);

  const botByActor = new Map(props.bots.map((b) => [String(b.actorId), b]));
  const names: Names = new Map(props.bots.map((b) => [b.id, String(b.name)]));
  // The `@prefix` right before the caret opens the popup.
  const typed = dismissed === draft ? null : /(?:^|\s)@([^\s@]*)$/.exec(draft.slice(0, caret));
  const query = typed?.[1]?.toLowerCase() ?? "";
  const matches = typed
    ? props.bots.filter((b) => String(b.name).toLowerCase().startsWith(query))
    : [];
  const highlighted = Math.min(active, matches.length - 1);
  const edit = (value: string, position: number) => {
    setDraft(value);
    setCaret(position);
    setActive(0);
  };
  const pick = (b: Row) => {
    const name = String(b.name);
    const start = caret - query.length - 1;
    picked.current.set(name, b.id);
    nextCaret.current = start + name.length + 2;
    edit(`${draft.slice(0, start)}@${name} ${draft.slice(caret)}`, nextCaret.current);
  };
  const posted = [
    ...new Map(
      props.messages.flatMap((m) => {
        const b = botByActor.get(String(m.actorId));
        return b ? [[b.id, b] as const] : [];
      }),
    ).values(),
  ];

  const send = async () => {
    if (!draft.trim() || !props.channel) return;
    const operationId = crypto.randomUUID();
    const result = await window.hive.api.command({
      operationId,
      idempotencyKey: crypto.randomUUID(),
      workspaceId: props.ws,
      command: {
        type: "message.post",
        channelId: props.channel.id,
        text: withTokens(draft, picked.current),
      },
    });
    if (!result.ok) return setOp({ operationId, jobIds: null, error: result.error.message });
    edit("", 0);
    picked.current.clear();
    const mentioned = (result.value.inboxItemIds as unknown[] | undefined)?.length ?? 0;
    setOp({ operationId, jobIds: mentioned === 0 ? [] : null });
    if (mentioned === 0) return;
    // Accepted is not started: Job ids appear once routing created them (§22.4). ponytail: polls 2 s for 10 min.
    for (let i = 0; i < 300; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const res = await window.hive.api.get(`/v1/operations/${encodeURIComponent(operationId)}`);
      const jobIds = res.ok ? (res.value.jobIds as (string | null)[] | undefined) : undefined;
      if (jobIds?.every((id) => typeof id === "string"))
        return setOp({ operationId, jobIds: jobIds as string[] });
    }
  };

  if (!props.channel) return <div className="empty">No channel yet.</div>;
  const name = text(props.channel.name);
  const memberCount = Number(props.channel.memberCount ?? 0);
  return (
    <div className="chat">
      <header className="chat-head">
        <button
          className={`icon star ${props.starred ? "starred" : ""}`}
          aria-label={props.starred ? `Unstar #${name}` : `Star #${name}`}
          aria-pressed={props.starred}
          onClick={props.toggleStar}
        >
          <Icon name="star" />
        </button>
        <div className="head-name">
          <button className="pill" onClick={props.toggleChannelPanel}>
            <span className="hash">#</span> {name}
          </button>
          {props.channel.topic ? (
            <span className="topic-line ellipsis">{text(props.channel.topic)}</span>
          ) : null}
        </div>
        <button
          className="members-button"
          aria-label={`${memberCount} ${memberCount === 1 ? "member" : "members"}`}
          onClick={() => props.openChannelPanel("members")}
        >
          <Icon name="users" /> {memberCount}
        </button>
        <button
          className="icon"
          aria-label="Channel details"
          onClick={() => props.openChannelPanel("about")}
        >
          <Icon name="more" />
        </button>
      </header>
      <div className="scroll">
        <p className="subtitle">
          {props.messages.length} messages
          {posted.length > 0 && " with "}
          {posted.map((b) => (
            <button key={b.id} className="inline-bot" onClick={() => props.openBot(b.id)}>
              <Avatar id={b.id} name={String(b.name)} size={16} /> {text(b.name)}
            </button>
          ))}
        </p>
        {byDay(props.messages).map((d) => (
          <section key={d.day} className="day">
            <span className="day-pill">{dayLabel(d.at)}</span>
            {d.messages.map((m) => {
              const at = new Date(String(m.createdAt));
              const author = botByActor.get(String(m.actorId));
              return (
                <article key={m.id} className="message">
                  <div className="author">
                    {author ? (
                      <button className="inline-bot" onClick={() => props.openBot(author.id)}>
                        <Avatar id={author.id} name={String(author.name)} size={20} />{" "}
                        {text(author.name)}
                      </button>
                    ) : (
                      <span>
                        {props.me && m.userId === props.me ? "You" : String(m.actorId).slice(0, 8)}
                      </span>
                    )}
                    <time>
                      {at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                    </time>
                  </div>
                  <div className="bubble">
                    <Markdown source={String(m.body ?? "")} names={names} />
                  </div>
                  <div className="hover-actions">
                    <button
                      title="Copy"
                      aria-label="Copy"
                      onClick={() =>
                        void navigator.clipboard.writeText(
                          String(m.body ?? "").replaceAll(
                            /<@bot:([^>\s]+)>/g,
                            (_, id: string) => `@${names.get(id) ?? "unknown"}`,
                          ),
                        )
                      }
                    >
                      <Icon name="copy" />
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        ))}
        <div ref={end} />
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {matches.length > 0 && (
          <ul className="mentions" role="listbox" aria-label="Mention a Bot">
            {matches.map((b, i) => (
              <li
                key={b.id}
                role="option"
                aria-selected={i === highlighted}
                // mousedown, not click: the textarea keeps focus and its caret.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(b);
                }}
              >
                <Avatar id={b.id} name={String(b.name)} size={20} /> {text(b.name)}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={box}
          rows={1}
          value={draft}
          onChange={(e) => edit(e.target.value, e.target.selectionStart)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (matches.length > 0) {
              const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
              if (step) {
                e.preventDefault();
                return setActive((highlighted + step + matches.length) % matches.length);
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                return pick(matches[highlighted]!);
              }
              if (e.key === "Escape") return setDismissed(draft);
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Message #${text(props.channel.name)}`}
          aria-label="Message"
        />
        <button className="send" aria-label="Send" disabled={!draft.trim()}>
          <Icon name="send" />
        </button>
      </form>
      <p className="op">
        {op && (
          <>
            operation <span className="mono">{op.operationId}</span>:{" "}
            {op.error ??
              (op.jobIds === null
                ? "accepted, routing pending"
                : op.jobIds.length === 0
                  ? "posted, no Bot mentioned"
                  : op.jobIds.map((id, i) => (
                      <Fragment key={id}>
                        {i === 0 ? (op.jobIds!.length > 1 ? "jobs " : "job ") : ", "}
                        <span className="mono">{id}</span>
                      </Fragment>
                    )))}
          </>
        )}
      </p>
    </div>
  );
};
