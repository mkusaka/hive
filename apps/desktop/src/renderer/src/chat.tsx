// The Channel conversation: header (star, name pill, topic, member count, "…"), day sections with sticky date pills, Markdown bubbles and the composer (message.post with @mentions).
// A DM uses the same view: its header is the Bot (opens the Bot panel) and every message goes to that Bot.
/* oxlint-disable no-await-in-loop */
import { Extension } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { SuggestionProps } from "@tiptap/suggestion";
import { Fragment, useEffect, useRef, useState } from "react";
import { everyone, type Inline, parseMarkdown, toMarkdown } from "./format.ts";
import { Avatar, Icon, type Row, text } from "./ui.tsx";

/** Bot id → name, for mention tokens. */
export type Names = ReadonlyMap<string, string>;

export const Inlines = ({ inlines, names }: { inlines: Inline[]; names: Names }) =>
  inlines.map((part, i) =>
    part.kind === "mention" ? (
      <span key={i} className="mention">
        @{part.id === everyone ? everyone : (names.get(part.id) ?? "unknown")}
      </span>
    ) : part.kind === "bold" ? (
      <strong key={i}>{part.text}</strong>
    ) : part.kind === "italic" ? (
      <em key={i}>{part.text}</em>
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

/**
 * `jobIds`: null while routing is pending, then the Jobs of the woken Bots (empty: nobody was woken); `busy` counts
 * deliveries that got no Job because the Bot was already working in this channel (ROUTE-02).
 */
type Operation = { operationId: string; jobIds: string[] | null; busy?: number; error?: string };

/**
 * The Bots the `@` suggestion offers for `query` (name prefix); in a DM only its Bot, the implicit recipient. With
 * `group` (a Channel's main conversation) `@everyone` comes last, also for the prefix of `all`.
 */
export const mentionItems = (bots: Row[], query: string, dmBot: string | null, group = false) => {
  const q = query.toLowerCase();
  return [
    ...bots.filter(
      (b) => (dmBot === null || b.id === dmBot) && String(b.name).toLowerCase().startsWith(q),
    ),
    ...(group && (everyone.startsWith(q) || "all".startsWith(q))
      ? [{ id: everyone, name: everyone }]
      : []),
  ];
};

type Suggestion = SuggestionProps<Row, { id: string; label: string }>;

/**
 * The message.post composer: a Tiptap editor with mention pills, the `@` popup and the operation line. `target` is the
 * command's address (`channelId` / `conversationId`, plus `threadOf` in a thread); `dmBot` limits `@` to a DM's Bot.
 */
export const Composer = (props: {
  ws: string;
  target: Record<string, string> | null;
  bots: Row[];
  dmBot: string | null;
  placeholder: string;
  label: string;
  /** After an accepted post, with the conversation it landed in. */
  onPosted?: (conversationId: string) => void;
  /** Offer `@everyone` (a Channel's main conversation). */
  group?: boolean;
  /** A Reply on this message (ROUTE-02): sent as `replyToMessageId`, shown above the editor until cleared. */
  replyTo?: { id: string; name: string; clear: () => void } | null;
}) => {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [active, setActive] = useState(0);
  const [empty, setEmpty] = useState(true);
  const [op, setOp] = useState<Operation | null>(null);
  /** What the editor's extensions (created once) read at call time. */
  const live = useRef({
    props,
    send: async () => {},
    keyDown: (_: KeyboardEvent): boolean => false,
    menuOpen: false,
  });
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        link: false,
      }),
      Placeholder.configure({ placeholder: () => live.current.props.placeholder }),
      Mention.configure({
        HTMLAttributes: { class: "mention" },
        suggestion: {
          items: ({ query }) => {
            const p = live.current.props;
            return mentionItems(p.bots, query, p.dmBot, p.group);
          },
          render: () => ({
            onStart: (s) => {
              setSuggestion(s);
              setActive(0);
            },
            onUpdate: (s) => {
              setSuggestion(s);
              setActive(0);
            },
            onKeyDown: ({ event }) => live.current.keyDown(event),
            onExit: () => setSuggestion(null),
          }),
        },
      }),
      // Above StarterKit's list / paragraph Enter; yields to the open suggestion, which picks on Enter.
      Extension.create({
        name: "composerKeys",
        priority: 1000,
        addKeyboardShortcuts: () => ({
          Enter: () => {
            if (live.current.menuOpen) return false;
            void live.current.send();
            return true;
          },
          // A new line in code, a new item in a list (an empty one leaves it), else a new paragraph, so "- " or
          // "1. " at its start makes a list.
          "Shift-Enter": ({ editor: e }) =>
            e.commands.first(({ commands }) => [
              () => commands.newlineInCode(),
              () => commands.splitListItem("listItem"),
              () => commands.splitBlock(),
            ]),
        }),
      }),
    ],
    editorProps: {
      attributes: { role: "textbox", "aria-label": props.label, "aria-multiline": "true" },
    },
    onUpdate: ({ editor: e }) => setEmpty(toMarkdown(e.getJSON()) === ""),
  });

  const matches = suggestion?.items ?? [];
  const highlighted = Math.min(active, matches.length - 1);
  const pick = (b: Row) => suggestion?.command({ id: b.id, label: String(b.name) });

  const send = async () => {
    const draft = editor ? toMarkdown(editor.getJSON()) : "";
    if (!draft || !props.target) return;
    const operationId = crypto.randomUUID();
    const result = await window.hive.api.command({
      operationId,
      idempotencyKey: crypto.randomUUID(),
      workspaceId: props.ws,
      command: {
        type: "message.post",
        ...props.target,
        ...(props.replyTo ? { replyToMessageId: props.replyTo.id } : {}),
        text: draft,
      },
    });
    if (!result.ok) return setOp({ operationId, jobIds: null, error: result.error.message });
    editor?.chain().clearContent(true).focus().run();
    props.replyTo?.clear();
    if (typeof result.value.conversationId === "string")
      props.onPosted?.(result.value.conversationId);
    const woken = (result.value.inboxItemIds as unknown[] | undefined)?.length ?? 0;
    setOp({ operationId, jobIds: woken === 0 ? [] : null });
    if (woken === 0) return;
    // Accepted is not started: Job ids appear once routing created them (§22.4). ponytail: polls 2 s for 10 min.
    for (let i = 0; i < 300; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const res = await window.hive.api.get(`/v1/operations/${encodeURIComponent(operationId)}`);
      const jobIds = res.ok ? (res.value.jobIds as (string | null)[] | undefined) : undefined;
      if (
        jobIds?.every((id) => typeof id === "string") ||
        (res.ok && res.value.routingStatus === "routed")
      )
        return setOp({
          operationId,
          jobIds: (jobIds ?? []).filter((id) => typeof id === "string"),
          busy: (jobIds ?? []).filter((id) => id === null).length,
        });
    }
  };

  live.current = {
    props,
    send,
    menuOpen: matches.length > 0,
    keyDown: (event) => {
      if (matches.length === 0) return false;
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (step) setActive((highlighted + step + matches.length) % matches.length);
      else if (event.key === "Enter" || event.key === "Tab") pick(matches[highlighted]!);
      else return event.key === "Escape";
      return true;
    },
  };
  // The placeholder is read when decorations are drawn: redraw them when the conversation changes.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr);
  }, [editor, props.placeholder]);

  return (
    <>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {props.replyTo && (
          <div className="replying">
            Replying to {props.replyTo.name}
            <button
              type="button"
              className="icon"
              aria-label="Cancel reply"
              onClick={props.replyTo.clear}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        {matches.length > 0 && (
          <ul className="mentions" role="listbox" aria-label="Mention a Bot">
            {matches.map((b, i) => (
              <li
                key={b.id}
                role="option"
                aria-selected={i === highlighted}
                // mousedown, not click: the editor keeps focus and its caret.
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
        <EditorContent editor={editor} className="composer-input" />
        <button className="send" aria-label="Send" disabled={empty}>
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
                : op.jobIds.length === 0 && !op.busy
                  ? "posted, no Bot woken"
                  : [
                      ...op.jobIds.map((id, i) => (
                        <Fragment key={id}>
                          {i === 0 ? (op.jobIds!.length > 1 ? "jobs " : "job ") : ", "}
                          <span className="mono">{id}</span>
                        </Fragment>
                      )),
                      op.busy
                        ? `${op.jobIds.length ? "; " : ""}${op.busy} busy ${op.busy === 1 ? "Bot reads" : "Bots read"} it in the current Job`
                        : "",
                    ])}
          </>
        )}
      </p>
    </>
  );
};

/** Mention tokens as `@name` (plain text: the clipboard, a reply quote). */
const renderTokens = (body: string, names: Names) =>
  body
    .replaceAll(/<@bot:([^>\s]+)>/g, (_, id: string) => `@${names.get(id) ?? "unknown"}`)
    .replaceAll("<@everyone>", "@everyone");

/** "You", a Bot's name or the actor id's start. */
const authorName = (m: Row, botByActor: Map<string, Row>, me: string | null) =>
  text(
    botByActor.get(String(m.actorId))?.name ??
      (me && m.userId === me ? "You" : String(m.actorId).slice(0, 8)),
  );

const time = (at: unknown) =>
  new Date(String(at)).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** A message's thread summary (`GET …/messages`). */
type ThreadSummary = {
  conversationId: string;
  replyCount: number;
  lastReplyAt: string;
  participants: string[];
};

/** One message: author, time, bubble, hover actions and, with replies, the thread footer. */
const Message = (props: {
  m: Row;
  bots: Row[];
  me: string | null;
  openBot: (id: string) => void;
  /** Reply in thread / the footer; absent inside a thread. */
  openThread?: (m: Row) => void;
  /** Reply (a quote that addresses a Bot's message to that Bot); only in a Channel's main conversation. */
  reply?: (m: Row) => void;
  /** The message this one replies to, when loaded. */
  quoted?: Row;
}) => {
  const { m } = props;
  const botByActor = new Map(props.bots.map((b) => [String(b.actorId), b]));
  const names: Names = new Map(props.bots.map((b) => [b.id, String(b.name)]));
  const author = botByActor.get(String(m.actorId));
  const thread = m.thread as ThreadSummary | null | undefined;
  return (
    <article className="message">
      <div className="author">
        {author ? (
          <button className="inline-bot" onClick={() => props.openBot(author.id)}>
            <Avatar id={author.id} name={String(author.name)} size={20} /> {text(author.name)}
          </button>
        ) : (
          <span>{props.me && m.userId === props.me ? "You" : String(m.actorId).slice(0, 8)}</span>
        )}
        <time>{time(m.createdAt)}</time>
      </div>
      {props.quoted && (
        <p className="reply-quote ellipsis">
          Replying to {authorName(props.quoted, botByActor, props.me)}:{" "}
          {renderTokens(String(props.quoted.body ?? ""), names)}
        </p>
      )}
      <div className="bubble">
        <Markdown source={String(m.body ?? "")} names={names} />
      </div>
      {thread && props.openThread && (
        <button className="thread-footer" onClick={() => props.openThread?.(m)}>
          {thread.participants.map((actorId) => {
            const b = botByActor.get(actorId);
            return b ? (
              <Avatar key={actorId} id={b.id} name={String(b.name)} size={18} />
            ) : (
              <Avatar key={actorId} id={actorId} name="?" size={18} plain />
            );
          })}
          <span className="replies">
            {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
          </span>
          <span className="last-reply">last reply {time(thread.lastReplyAt)}</span>
        </button>
      )}
      <div className="hover-actions">
        {props.reply && (
          <button title="Reply" aria-label="Reply" onClick={() => props.reply?.(m)}>
            <Icon name="reply" />
          </button>
        )}
        {props.openThread && (
          <button
            title="Reply in thread"
            aria-label="Reply in thread"
            onClick={() => props.openThread?.(m)}
          >
            <Icon name="thread" />
          </button>
        )}
        <button
          title="Copy"
          aria-label="Copy"
          onClick={() =>
            void navigator.clipboard.writeText(renderTokens(String(m.body ?? ""), names))
          }
        >
          <Icon name="copy" />
        </button>
      </div>
    </article>
  );
};

export const ChannelView = (props: {
  ws: string;
  /** The Channel, or with `dm` the DM row (`id` = conversation id, `botId`, `name`). */
  channel: Row | undefined;
  dm: boolean;
  messages: Row[];
  bots: Row[];
  me: string | null;
  openBot: (id: string) => void;
  openThread: (m: Row) => void;
  toggleChannelPanel: () => void;
  /** The header's member count (Members) and "…" (About). */
  openChannelPanel: (tab: "about" | "members") => void;
  starred: boolean;
  toggleStar: () => void;
  /** `GET /v1/channels/:id/presence`: per member Bot `reading` / `working` / `idle` (ROUTE-02). */
  presence: Row[];
}) => {
  const end = useRef<HTMLDivElement>(null);
  const [replyTo, setReplyTo] = useState<Row | null>(null);
  useEffect(() => setReplyTo(null), [props.channel?.id]);
  // Braces: Chromium's scrollIntoView returns a Promise, which React would call as the cleanup.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: "end" });
  }, [props.messages]);

  const botByActor = new Map(props.bots.map((b) => [String(b.actorId), b]));
  const posted = [
    ...new Map(
      props.messages.flatMap((m) => {
        const b = botByActor.get(String(m.actorId));
        return b ? [[b.id, b] as const] : [];
      }),
    ).values(),
  ];

  const byId = new Map(props.messages.map((m) => [m.id, m]));
  const active = props.presence.filter((p) => p.state === "reading" || p.state === "working");
  const name = text(props.channel?.name);
  const title = props.dm ? name : `#${name}`;
  if (!props.channel) return <div className="empty">No channel yet.</div>;
  const memberCount = Number(props.channel.memberCount ?? 0);
  const dmBot = String(props.channel.botId);
  return (
    <div className="chat">
      <header className="chat-head">
        <button
          className={`icon star ${props.starred ? "starred" : ""}`}
          aria-label={props.starred ? `Unstar ${title}` : `Star ${title}`}
          aria-pressed={props.starred}
          onClick={props.toggleStar}
        >
          <Icon name="star" />
        </button>
        {props.dm ? (
          <div className="head-name">
            <button className="pill" onClick={() => props.openBot(dmBot)}>
              <Avatar id={dmBot} name={name} size={20} /> {name}
            </button>
          </div>
        ) : (
          <>
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
              {active.map((p) => (
                <span
                  key={String(p.botId)}
                  className={`presence ${text(p.state)}`}
                  title={`${text(p.name)} is ${text(p.state)}`}
                >
                  <Avatar id={String(p.botId)} name={String(p.name)} size={16} />
                </span>
              ))}
              <Icon name="users" /> {memberCount}
            </button>
            <button
              className="icon"
              aria-label="Channel details"
              onClick={() => props.openChannelPanel("about")}
            >
              <Icon name="more" />
            </button>
          </>
        )}
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
            {d.messages.map((m) => (
              <Message
                key={m.id}
                m={m}
                bots={props.bots}
                me={props.me}
                openBot={props.openBot}
                openThread={props.openThread}
                reply={props.dm ? undefined : setReplyTo}
                quoted={m.replyToMessageId ? byId.get(String(m.replyToMessageId)) : undefined}
              />
            ))}
          </section>
        ))}
        <div ref={end} />
      </div>
      <Composer
        ws={props.ws}
        target={props.dm ? { conversationId: props.channel.id } : { channelId: props.channel.id }}
        bots={props.bots}
        dmBot={props.dm ? dmBot : null}
        placeholder={`Message ${title}`}
        label="Message"
        group={!props.dm}
        replyTo={
          replyTo && {
            id: replyTo.id,
            name: authorName(replyTo, botByActor, props.me),
            clear: () => setReplyTo(null),
          }
        }
      />
    </div>
  );
};

/**
 * The Thread panel: the root message, its replies (oldest first) and a "Reply…" composer posting with `threadOf`.
 * `target` addresses the root's Channel / DM.
 */
export const ThreadPanel = (props: {
  ws: string;
  title: string;
  root: Row;
  replies: Row[];
  target: Record<string, string>;
  dmBot: string | null;
  bots: Row[];
  me: string | null;
  openBot: (id: string) => void;
  onPosted: (conversationId: string) => void;
  close: () => void;
}) => (
  <aside className="panel thread-panel" aria-label="Thread">
    <div className="panel-top">
      <h2>
        Thread <span className="muted">{props.title}</span>
      </h2>
      <button className="round" aria-label="Close" onClick={props.close}>
        <Icon name="close" />
      </button>
    </div>
    <div className="scroll">
      <Message m={props.root} bots={props.bots} me={props.me} openBot={props.openBot} />
      <p className="reply-count">
        {props.replies.length} {props.replies.length === 1 ? "reply" : "replies"}
      </p>
      {props.replies.map((m) => (
        <Message key={m.id} m={m} bots={props.bots} me={props.me} openBot={props.openBot} />
      ))}
    </div>
    <Composer
      ws={props.ws}
      target={{ ...props.target, threadOf: props.root.id }}
      bots={props.bots}
      dmBot={props.dmBot}
      placeholder="Reply…"
      label="Reply"
      onPosted={props.onPosted}
    />
  </aside>
);
