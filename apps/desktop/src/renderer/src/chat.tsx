// The Channel conversation: header pill, date-divided Markdown bubbles and the composer (agent.send).
/* oxlint-disable no-await-in-loop */
import { Fragment, useEffect, useRef, useState } from "react";
import { type Inline, parseMarkdown } from "./format.ts";
import { Avatar, Icon, type Row, text } from "./ui.tsx";

const Inlines = ({ inlines }: { inlines: Inline[] }) =>
  inlines.map((part, i) =>
    part.kind === "bold" ? (
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
export const Markdown = ({ source }: { source: string }) =>
  parseMarkdown(source).map((block, i) => {
    if (block.kind === "code") return <pre key={i}>{block.text}</pre>;
    if (block.kind === "p")
      return (
        <p key={i}>
          <Inlines inlines={block.inlines} />
        </p>
      );
    const List = block.kind;
    return (
      <List key={i}>
        {block.items.map((item, j) => (
          <li key={j}>
            <Inlines inlines={item} />
          </li>
        ))}
      </List>
    );
  });

const dayLabel = (at: Date) => {
  const days = Math.round(
    (new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${at.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} ${time}`;
};

type Operation = { operationId: string; jobId: string | null; error?: string };

export const ChannelView = (props: {
  ws: string;
  channel: Row | undefined;
  messages: Row[];
  bots: Row[];
  botId: string;
  setBotId: (id: string) => void;
  me: string | null;
  openBot: (id: string) => void;
  toggleChannelPanel: () => void;
}) => {
  const [draft, setDraft] = useState("");
  const [op, setOp] = useState<Operation | null>(null);
  const end = useRef<HTMLDivElement>(null);
  // Braces: Chromium's scrollIntoView returns a Promise, which React would call as the cleanup.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: "end" });
  }, [props.messages]);

  const botByActor = new Map(props.bots.map((b) => [String(b.actorId), b]));
  const bot = props.bots.find((b) => b.id === props.botId);
  const posted = [
    ...new Map(
      props.messages.flatMap((m) => {
        const b = botByActor.get(String(m.actorId));
        return b ? [[b.id, b] as const] : [];
      }),
    ).values(),
  ];

  const send = async () => {
    if (!draft.trim() || !props.botId || !props.channel) return;
    const operationId = crypto.randomUUID();
    const result = await window.hive.api.command({
      operationId,
      idempotencyKey: crypto.randomUUID(),
      workspaceId: props.ws,
      command: {
        type: "agent.send",
        recipientBotId: props.botId,
        channelId: props.channel.id,
        message: { kind: "request", text: draft },
        delivery: "wake",
      },
    });
    if (!result.ok) return setOp({ operationId, jobId: null, error: result.error.message });
    setDraft("");
    setOp({ operationId, jobId: null });
    // Accepted is not started: the Job id appears once routing created it (§22.4). ponytail: polls 2 s for 10 min.
    for (let i = 0; i < 300; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const res = await window.hive.api.get(`/v1/operations/${encodeURIComponent(operationId)}`);
      if (res.ok && typeof res.value.jobId === "string")
        return setOp({ operationId, jobId: res.value.jobId });
    }
  };

  if (!props.channel) return <div className="empty">No channel yet.</div>;
  let lastDay = "";
  return (
    <div className="chat">
      <header className="chat-head">
        <button className="pill" onClick={props.toggleChannelPanel}>
          <span className="hash">#</span> {text(props.channel.name)}
        </button>
        {props.channel.topic ? (
          <span className="topic-line ellipsis">{text(props.channel.topic)}</span>
        ) : null}
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
        {props.messages.map((m) => {
          const at = new Date(String(m.createdAt));
          const day = at.toDateString();
          const divider = day !== lastDay;
          lastDay = day;
          const author = botByActor.get(String(m.actorId));
          return (
            <Fragment key={m.id}>
              {divider && <p className="divider">{dayLabel(at)}</p>}
              <article className="message">
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
                  <Markdown source={String(m.body ?? "")} />
                </div>
                <div className="hover-actions">
                  <button
                    title="Copy"
                    aria-label="Copy"
                    onClick={() => void navigator.clipboard.writeText(String(m.body ?? ""))}
                  >
                    <Icon name="copy" />
                  </button>
                </div>
              </article>
            </Fragment>
          );
        })}
        <div ref={end} />
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <select
          className="bot-pick"
          value={props.botId}
          onChange={(e) => props.setBotId(e.target.value)}
          aria-label="Bot"
        >
          {props.bots.map((b) => (
            <option key={b.id} value={b.id}>
              {text(b.name)}
            </option>
          ))}
        </select>
        <textarea
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Message ${bot ? text(bot.name) : "a Bot"}`}
          aria-label="Message"
        />
        <button
          className="send"
          aria-label="Send"
          disabled={!draft.trim() || !props.botId || !props.channel}
        >
          <Icon name="send" />
        </button>
      </form>
      <p className="op">
        {op && (
          <>
            operation <span className="mono">{op.operationId}</span>:{" "}
            {op.error ??
              (op.jobId ? (
                <>
                  job <span className="mono">{op.jobId}</span>
                </>
              ) : (
                "accepted, routing pending"
              ))}
          </>
        )}
      </p>
    </div>
  );
};
