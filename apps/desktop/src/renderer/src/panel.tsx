// The Bot panel (Details / Library / Computer), the Channel panel (About / Members / Routines), the routine list with its menu
// and editor shared by both, and the executor service section of the Computer tab.
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { FilterExpression, parse, type FilterExpression as Filter } from "@hive/contracts";
import type { ExecutorProvider, UiCommand } from "../../shared/api.ts";
import { type Schedule, scheduleLine } from "./format.ts";
import { Avatar, failure, Icon, inWorkspace, MemoryList, Menu, type Row, text } from "./ui.tsx";
import { SetUpPc } from "./welcome.tsx";

type Tab = "details" | "library" | "computer";

const command = (ws: string, cmd: UiCommand["command"]) =>
  window.hive.api.command({
    operationId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    workspaceId: ws,
    command: cmd,
  });

/** Close button, blob and name, tabs: the chrome both panels share. */
const PanelChrome = <T extends string>(props: {
  id: string;
  name: string;
  title: ReactNode;
  tabs: readonly T[];
  tab: T;
  setTab: (tab: T) => void;
  close: () => void;
  children: ReactNode;
}) => (
  <aside className="panel">
    <div className="panel-top">
      <button className="round" aria-label="Close" onClick={props.close}>
        <Icon name="close" />
      </button>
    </div>
    <div className="panel-id">
      <Avatar id={props.id} name={props.name} size={88} />
      <h2>{props.title}</h2>
    </div>
    <div className="tabs" role="tablist">
      {props.tabs.map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={t === props.tab}
          className={t === props.tab ? "active" : ""}
          onClick={() => props.setTab(t)}
        >
          {t[0]!.toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
    {props.children}
  </aside>
);

export const BotPanel = (props: {
  ws: string;
  bot: Row;
  bots: Row[];
  channels: Row[];
  devices: Row[];
  refreshDevices: () => void;
  close: () => void;
}) => {
  const [tab, setTab] = useState<Tab>("details");
  const [memories, setMemories] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { ws, bot, refreshDevices } = props;

  useEffect(() => {
    setError(null);
    if (tab === "library")
      void window.hive.api
        .get(inWorkspace("memories", ws, { scopeKind: "bot", scopeId: bot.id }))
        .then((res) =>
          res.ok ? setMemories(res.value.memories as Row[]) : setError(failure(res)),
        );
    // Heartbeats write no change rows, so online state is refetched when the tab opens.
    if (tab === "computer") refreshDevices();
  }, [tab, ws, bot.id, refreshDevices]);

  const channelOf = (r: Row) => props.channels.find((c) => c.conversationId === r.conversationId);
  return (
    <PanelChrome
      id={bot.id}
      name={String(bot.name)}
      title={text(bot.name)}
      tabs={["details", "library", "computer"] as const}
      tab={tab}
      setTab={setTab}
      close={props.close}
    >
      {error && <p className="error">{error}</p>}
      {tab === "details" && (
        <>
          <h3>Instructions</h3>
          <div className="card">
            <p className="pre">{text(bot.instructions) || "—"}</p>
          </div>
          <h3>Tool policy</h3>
          <div className="card">
            <pre className="mono">{JSON.stringify(bot.toolPolicy, null, 2)}</pre>
          </div>
          <h3>Routines</h3>
          {/* All channels; routines are created from a Channel panel. */}
          <Routines
            ws={ws}
            query={{ botId: bot.id }}
            bots={props.bots}
            side={(r) => {
              const channel = channelOf(r);
              return channel ? `# ${text(channel.name)}` : "no channel";
            }}
          />
        </>
      )}
      {tab === "library" && (
        <>
          <h3>Memories</h3>
          <div className="card">
            {memories.length === 0 && <p className="meta">No memories for this Bot.</p>}
            <MemoryList memories={memories} />
          </div>
        </>
      )}
      {tab === "computer" && (
        <>
          <ExecutorSection />
          <h3>Devices</h3>
          <div className="card">
            {props.devices.map((d) => {
              // Online = heartbeat within 45 s, as placement counts it (api-worker placement.ts).
              const online =
                typeof d.lastHeartbeatAt === "string" &&
                Date.now() - Date.parse(d.lastHeartbeatAt) <= 45_000;
              return (
                <dl key={d.id} className="device">
                  <dt>
                    {text(d.name)}{" "}
                    <span className={online ? "ok" : "warn"}>{online ? "online" : "offline"}</span>
                    {d.revokedAt ? (
                      <span className="error"> revoked {text(d.revokedAt)}</span>
                    ) : null}
                  </dt>
                  <dd>
                    {text(d.os)} · capacity {text(d.capacityBackground)} ·{" "}
                    {Array.isArray(d.capabilities) ? d.capabilities.join(", ") : "—"}
                  </dd>
                  <dd className="meta">last heartbeat {text(d.lastHeartbeatAt)}</dd>
                </dl>
              );
            })}
          </div>
        </>
      )}
    </PanelChrome>
  );
};

/**
 * Channel details, like Slack's: About (name, topic edited inline, created date), Members (`GET
 * /v1/channels/:id/members`, "Add bot" → channel.join, a Bot's row menu → channel.leave) and Routines (each with its
 * assigned Bot).
 */
export type ChannelTab = "about" | "members" | "routines";

/** Where a menu opened from a button goes: under it. */
const below = (e: { currentTarget: Element }) => {
  const box = e.currentTarget.getBoundingClientRect();
  return { x: box.left, y: box.bottom + 4 };
};

/** `tab` is App state: the header's member count opens Members, its "…" About. */
export const ChannelPanel = (props: {
  ws: string;
  channel: Row;
  bots: Row[];
  me: string | null;
  defaultBotId: string;
  openBot: (id: string) => void;
  refreshChannels: () => void;
  close: () => void;
  tab: ChannelTab;
  setTab: (tab: ChannelTab) => void;
  /** The open Channel's Bot presence (ROUTE-02), shown in Members. */
  presence: Row[];
}) => {
  const { tab, setTab } = props;
  const [members, setMembers] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  // "Add bot" picker, or a Bot member's row menu.
  const [menu, setMenu] = useState<{ x: number; y: number; botId?: string } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const { ws, channel } = props;
  const conversationId = String(channel.conversationId);
  const loadMembers = useCallback(
    () =>
      void window.hive.api
        .get(inWorkspace(`channels/${encodeURIComponent(channel.id)}/members`, ws))
        .then((res) => (res.ok ? setMembers(res.value.members as Row[]) : setError(failure(res)))),
    [ws, channel.id],
  );
  useEffect(() => {
    setError(null);
    if (tab === "members") loadMembers();
  }, [tab, loadMembers]);
  const membership = async (type: "channel.join" | "channel.leave", botId: string) => {
    setMenu(null);
    const res = await command(ws, { type, channelId: channel.id, botId });
    if (!res.ok) return setError(failure(res));
    setError(null);
    loadMembers();
    props.refreshChannels();
  };
  const saveTopic = async (topic: string) => {
    const res = await command(ws, { type: "channel.update", channelId: channel.id, topic });
    if (!res.ok) return setError(failure(res));
    setError(null);
    props.refreshChannels();
  };
  return (
    <PanelChrome
      id={channel.id}
      name={String(channel.name)}
      title={`# ${text(channel.name)}`}
      tabs={["about", "members", "routines"] as const}
      tab={tab}
      setTab={setTab}
      close={props.close}
    >
      {error && <p className="error">{error}</p>}
      {tab === "about" && (
        <div className="card about">
          <div className="meta">Channel name</div>
          <div># {text(channel.name)}</div>
          <div className="meta">Topic</div>
          <Topic key={channel.id} topic={(channel.topic as string | null) ?? ""} save={saveTopic} />
          <div className="meta">Created</div>
          <div>
            {new Date(String(channel.createdAt)).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </div>
        </div>
      )}
      {tab === "members" && (
        <div className="card">
          <button className="member" onClick={(e) => setMenu(below(e))}>
            <Icon name="users" /> Add bot
          </button>
          {members.map((m) => {
            const label =
              m.userId && m.userId === props.me ? `${text(m.name)} (you)` : text(m.name);
            return m.botId ? (
              <div key={m.actorId as string} className="member-row">
                <button
                  className="inline-bot member"
                  onClick={() => props.openBot(String(m.botId))}
                >
                  <Avatar id={String(m.botId)} name={String(m.name)} size={28} /> {label}
                </button>
                <span className="meta presence-state">
                  {text(props.presence.find((p) => p.botId === m.botId)?.state ?? "idle")}
                </span>
                <button
                  className="icon"
                  aria-label={`${label} actions`}
                  aria-haspopup="menu"
                  onClick={(e) => setMenu({ ...below(e), botId: String(m.botId) })}
                >
                  <Icon name="more" />
                </button>
              </div>
            ) : (
              <div key={m.actorId as string} className="member">
                <Avatar id={String(m.actorId)} name={String(m.name)} size={28} plain /> {label}
                {m.role === "owner" && <span className="meta">owner</span>}
              </div>
            );
          })}
          {menu && (
            <Menu x={menu.x} y={menu.y} close={closeMenu}>
              {menu.botId ? (
                <button
                  role="menuitem"
                  onClick={() => void membership("channel.leave", menu.botId!)}
                >
                  <Icon name="trash" /> Remove from channel
                </button>
              ) : (
                props.bots
                  .filter((b) => !members.some((m) => m.botId === b.id))
                  .map((b) => (
                    <button
                      key={b.id}
                      role="menuitem"
                      onClick={() => void membership("channel.join", b.id)}
                    >
                      <Avatar id={b.id} name={String(b.name)} size={20} /> {text(b.name)}
                    </button>
                  ))
              )}
            </Menu>
          )}
        </div>
      )}
      {tab === "routines" && (
        <Routines
          key={conversationId}
          ws={ws}
          query={{ conversationId }}
          bots={props.bots}
          create={{ conversationId, botId: props.defaultBotId }}
          side={(r) => {
            const bot = props.bots.find((b) => b.id === r.botId);
            return (
              <>
                <Avatar id={String(r.botId)} name={String(bot?.name ?? "?")} size={16} />{" "}
                {text(bot?.name)}
              </>
            );
          }}
        />
      )}
    </PanelChrome>
  );
};

/** Click to edit; Enter or blur saves (when changed), Escape cancels. */
const Topic = (props: { topic: string; save: (topic: string) => Promise<void> }) => {
  const [draft, setDraft] = useState<string | null>(null);
  // Escape unmounts the focused input, which would blur and save without this.
  const cancelled = useRef(false);
  if (draft === null)
    return (
      <button
        className={`topic ${props.topic ? "" : "meta"}`}
        onClick={() => {
          cancelled.current = false;
          setDraft(props.topic);
        }}
      >
        {props.topic || "Add a topic"}
      </button>
    );
  const commit = () => {
    if (cancelled.current) return;
    cancelled.current = true;
    if (draft !== props.topic) void props.save(draft);
    setDraft(null);
  };
  return (
    <input
      autoFocus
      maxLength={250}
      value={draft}
      aria-label="Topic"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) commit();
        if (e.key === "Escape") {
          cancelled.current = true;
          setDraft(null);
        }
      }}
    />
  );
};

type Menu = { routine: Row; x: number; y: number };
type Editing = { routine: Row | null };

/**
 * Routines matching `query`: name, schedule line, `side` (the Bot or the Channel), an on / off switch and a menu
 * ("…" or right-click: Pause / Resume, Edit, Run now, Delete). With `create`, a "New routine" button. Loaded on mount
 * and after its own commands (no change-row refetch).
 */
const Routines = (props: {
  ws: string;
  query: Record<string, string>;
  bots: Row[];
  side: (r: Row) => ReactNode;
  create?: { conversationId: string; botId: string };
}) => {
  const { ws } = props;
  const [routines, setRoutines] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const query = JSON.stringify(props.query);

  const load = useCallback(async () => {
    const res = await window.hive.api.get(
      inWorkspace("routines", ws, JSON.parse(query) as Record<string, string>),
    );
    if (!res.ok) return setError(failure(res));
    setRoutines(res.value.routines as Row[]);
  }, [ws, query]);
  useEffect(() => void load(), [load]);
  const closeMenu = useCallback(() => setMenu(null), []);

  const act = async (cmd: UiCommand["command"]) => {
    setMenu(null);
    const res = await command(ws, cmd);
    setError(res.ok ? null : failure(res));
    void load();
  };
  const openMenu = (routine: Row, x: number, y: number) => setMenu({ routine, x, y });

  if (editing)
    return (
      <RoutineEditor
        ws={ws}
        bots={props.bots}
        routine={editing.routine}
        create={props.create}
        done={(message) => {
          setEditing(null);
          setError(message);
          void load();
        }}
      />
    );
  return (
    <>
      {error && <p className="error">{error}</p>}
      <div className="card">
        {routines.length === 0 && <p className="meta">No routines.</p>}
        {routines.map((r) => (
          <div
            key={r.id}
            className="routine"
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(r, e.clientX, e.clientY);
            }}
          >
            <div className="routine-text">
              <div className="ellipsis">{text(r.name)}</div>
              <div className="meta ellipsis">{scheduleLine(r.schedule as Schedule)}</div>
              <div className="meta ellipsis routine-side">{props.side(r)}</div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={Boolean(r.enabled)}
                aria-label={`${text(r.name)} enabled`}
                onChange={() =>
                  void act({
                    type: r.enabled ? "routine.pause" : "routine.resume",
                    routineId: r.id,
                  })
                }
              />
              <span />
            </label>
            <button
              className="icon"
              aria-label={`${text(r.name)} actions`}
              aria-haspopup="menu"
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                openMenu(r, box.left, box.bottom + 4);
              }}
            >
              <Icon name="more" />
            </button>
          </div>
        ))}
      </div>
      {props.create && (
        <button className="new-routine" onClick={() => setEditing({ routine: null })}>
          New routine
        </button>
      )}
      {menu && (
        <Menu x={menu.x} y={menu.y} close={closeMenu}>
          <button
            role="menuitem"
            onClick={() =>
              void act({
                type: menu.routine.enabled ? "routine.pause" : "routine.resume",
                routineId: menu.routine.id,
              })
            }
          >
            <Icon name={menu.routine.enabled ? "pause" : "play"} />
            {menu.routine.enabled ? "Pause" : "Resume"}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setEditing({ routine: menu.routine });
              setMenu(null);
            }}
          >
            <Icon name="edit" /> Edit
          </button>
          <button
            role="menuitem"
            onClick={() => void act({ type: "routine.run", routineId: menu.routine.id })}
          >
            <Icon name="send" /> Run now
          </button>
          <hr />
          <button
            role="menuitem"
            className="danger"
            onClick={() => void act({ type: "routine.delete", routineId: menu.routine.id })}
          >
            <Icon name="trash" /> Delete
          </button>
        </Menu>
      )}
    </>
  );
};

/** `datetime-local` value (this machine's zone) for an ISO instant. */
const localInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const eventTypePrefix = (filter: Filter): string => {
  if (filter.op === "prefix" && filter.field === "type" && typeof filter.value === "string")
    return filter.value;
  if (filter.op === "and") {
    for (const node of filter.nodes) {
      const prefix = eventTypePrefix(node);
      if (prefix) return prefix;
    }
  }
  return "";
};

/**
 * Create (`routine.create` into the Channel's conversation) or edit (`routine.update` with `expectedRevision`, only
 * the changed fields, so a rename keeps the schedule revision). The Bot of an existing routine cannot change.
 */
const RoutineEditor = (props: {
  ws: string;
  bots: Row[];
  routine: Row | null;
  create?: { conversationId: string; botId: string };
  done: (message: string | null) => void;
}) => {
  const r = props.routine;
  const old = r?.schedule as Schedule | undefined;
  const [name, setName] = useState(r ? String(r.name) : "");
  const [botId, setBotId] = useState(
    r ? String(r.botId) : (props.create?.botId ?? props.bots[0]?.id ?? ""),
  );
  const [kind, setKind] = useState<Schedule["kind"]>(old?.kind ?? "cron");
  const [expr, setExpr] = useState(old?.kind === "cron" ? old.expr : "0 9 * * 1-5");
  const [timezone, setTimezone] = useState(
    old?.kind === "cron" ? old.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [at, setAt] = useState(old?.kind === "once" ? localInput(old.at) : "");
  const oldEventFilter = old?.kind === "event" ? old.filter : undefined;
  const oldType = oldEventFilter ? eventTypePrefix(oldEventFilter) : "";
  const remainingFilter =
    oldEventFilter?.op === "and"
      ? oldEventFilter.nodes.filter(
          (node) =>
            !(node.op === "prefix" && node.field === "type" && typeof node.value === "string"),
        )
      : oldType
        ? []
        : oldEventFilter
          ? [oldEventFilter]
          : [];
  const initialFilterJson =
    remainingFilter.length === 0
      ? ""
      : JSON.stringify(
          remainingFilter.length === 1 ? remainingFilter[0] : { op: "and", nodes: remainingFilter },
          null,
          2,
        );
  const [eventType, setEventType] = useState(oldType);
  const [filterJson, setFilterJson] = useState(initialFilterJson);
  const [inputText, setInputText] = useState(r ? String(r.inputText) : "");
  const [misfire, setMisfire] = useState(r ? String(r.misfire) : "coalesce");
  const [apiUrl, setApiUrl] = useState("");
  const [secret, setSecret] = useState<{ value: string; hookPath: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hookPath = r && typeof r.hookPath === "string" ? r.hookPath : null;

  useEffect(() => {
    void window.hive.getConfig().then((config) => setApiUrl(config.apiUrl));
  }, []);

  const setDisclosure = (value: Record<string, unknown>) => {
    if (
      "secret" in value &&
      typeof value.secret === "string" &&
      "hookPath" in value &&
      typeof value.hookPath === "string"
    ) {
      setSecret({ value: value.secret, hookPath: value.hookPath });
      return true;
    }
    return false;
  };

  const schedule = (): Schedule | null => {
    if (kind === "cron") return { kind, expr: expr.trim(), timezone };
    if (kind === "once") return { kind, at: new Date(at).toISOString() };
    if (kind === "webhook") return { kind };
    if (old?.kind === "event" && eventType === oldType && filterJson === initialFilterJson)
      return old;
    let extra: Filter | null = null;
    if (filterJson.trim()) {
      try {
        const result = parse(FilterExpression, JSON.parse(filterJson));
        if (!result.ok) {
          setError(result.issues.join("; "));
          return null;
        }
        extra = result.value;
      } catch {
        setError("Filter must be valid JSON.");
        return null;
      }
    }
    if (!eventType.trim() && !extra) {
      setError("Enter an event type prefix or filter JSON.");
      return null;
    }
    const filter: Filter = eventType.trim()
      ? extra
        ? { op: "and", nodes: [{ op: "prefix", field: "type", value: eventType.trim() }, extra] }
        : { op: "prefix", field: "type", value: eventType.trim() }
      : extra!;
    const result = parse(FilterExpression, filter);
    if (!result.ok) {
      setError(result.issues.join("; "));
      return null;
    }
    return { kind, filter: result.value };
  };

  const save = async () => {
    if (secret) return;
    const next = schedule();
    if (!next) return;
    const misfirePolicy = misfire as "skip" | "coalesce";
    const res = r
      ? await command(props.ws, {
          type: "routine.update",
          routineId: r.id,
          expectedRevision: Number(r.revision),
          ...(name !== r.name ? { name } : {}),
          ...(JSON.stringify(next) !== JSON.stringify(old) ? { schedule: next } : {}),
          ...(inputText !== r.inputText ? { inputText } : {}),
          ...(misfire !== r.misfire ? { misfire: misfirePolicy } : {}),
        })
      : await command(props.ws, {
          type: "routine.create",
          botId,
          name,
          schedule: next,
          inputText,
          misfire: misfirePolicy,
          conversationId: props.create?.conversationId,
        });
    if (res.ok) {
      if (setDisclosure(res.value)) return;
      return props.done(null);
    }
    if (res.error.code === "REVISION_CONFLICT")
      return props.done("The routine changed elsewhere; reloaded. Edit it again.");
    setError(failure(res));
  };

  const rotate = async () => {
    if (!r || secret) return;
    const res = await command(props.ws, { type: "routine.rotate_secret", routineId: r.id });
    if (res.ok && setDisclosure(res.value)) return;
    setError(res.ok ? "The server did not return a new secret." : failure(res));
  };

  const shownHookPath = secret?.hookPath ?? hookPath;
  return (
    <form
      className="card editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h4>{r ? "Edit routine" : "New routine"}</h4>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        Bot
        <select value={botId} disabled={Boolean(r)} onChange={(e) => setBotId(e.target.value)}>
          {props.bots.map((b) => (
            <option key={b.id} value={b.id}>
              {text(b.name)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Trigger
        <select
          value={kind}
          onChange={(e) => {
            const next = e.target.value as Schedule["kind"];
            if (next !== "webhook") setSecret(null);
            setKind(next);
          }}
        >
          <option value="cron">Repeat</option>
          <option value="once">Once</option>
          <option value="webhook">Webhook</option>
          <option value="event">When an event matches</option>
        </select>
      </label>
      {kind === "cron" && (
        <>
          <label>
            Cron
            <input
              className="mono"
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              placeholder="m h dom mon dow"
              required
            />
          </label>
          <p className="meta">{scheduleLine({ kind, expr, timezone })}</p>
          <label>
            Timezone
            <input value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
          </label>
        </>
      )}
      {kind === "once" && (
        <label>
          At
          <input
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
            required
          />
        </label>
      )}
      {kind === "event" && (
        <>
          <label>
            Event type prefix
            <input
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              placeholder="github.pull_request"
            />
          </label>
          <label>
            Filter JSON (optional)
            <textarea rows={4} value={filterJson} onChange={(e) => setFilterJson(e.target.value)} />
          </label>
        </>
      )}
      {kind === "webhook" && (
        <>
          {shownHookPath && (
            <label>
              Webhook URL
              <input readOnly value={`${apiUrl.replace(/\/$/, "")}${shownHookPath}`} />
            </label>
          )}
          {r && (
            <button type="button" disabled={Boolean(secret)} onClick={() => void rotate()}>
              Rotate secret
            </button>
          )}
          {secret && (
            <label>
              Secret (shown once)
              <input readOnly value={secret.value} />
            </label>
          )}
        </>
      )}
      <label>
        Input
        <textarea
          rows={3}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          required
        />
      </label>
      <label>
        Misfire
        <select value={misfire} onChange={(e) => setMisfire(e.target.value)}>
          <option value="coalesce">coalesce (run the latest missed)</option>
          <option value="skip">skip (drop if more than 5 min late)</option>
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        {!secret && (
          <button type="submit" disabled={!botId}>
            {r ? "Save" : "Create"}
          </button>
        )}
        <button type="button" onClick={() => props.done(null)}>
          {secret ? "Done" : "Cancel"}
        </button>
      </div>
    </form>
  );
};

/**
 * This PC's executor launchd service (README "Executor service"), polled every 10 s while shown. Stop only unloads it;
 * the next app start brings it back (permanent removal: `hive executor uninstall`).
 */
const ExecutorSection = () => {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<ExecutorProvider>("claude");
  const [concurrency, setConcurrency] = useState(1);
  const [busy, setBusy] = useState(false);
  const show = (result: Awaited<ReturnType<typeof window.hive.executor.status>>) => {
    if (result.ok) {
      setStatus(result.value);
      setError(null);
    } else setError(`${result.error.code}: ${result.error.message}`);
  };
  const refresh = useCallback(async () => show(await window.hive.executor.status()), []);
  useEffect(() => {
    void window.hive.executor.status().then((result) => {
      show(result);
      // The form starts from what is installed.
      if (!result.ok) return;
      if (typeof result.value.provider === "string")
        setProvider(result.value.provider as ExecutorProvider);
      if (typeof result.value.concurrency === "number") setConcurrency(result.value.concurrency);
    });
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const act = async (call: () => ReturnType<typeof window.hive.executor.stop>) => {
    setBusy(true);
    const result = await call();
    setBusy(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    await refresh();
  };
  const logs = status?.logs as { stdout?: string; stderr?: string } | undefined;
  const state = !status
    ? "—"
    : !status.installed
      ? "not installed"
      : status.pid
        ? `loaded, pid ${text(status.pid)}`
        : `stopped, last exit code ${text(status.lastExitCode)}`;
  return (
    <>
      <h3>Executor on this PC</h3>
      {status?.registered === false && <SetUpPc onDone={() => void refresh()} />}
      <div className="card">
        {error && <p className="error">{error}</p>}
        <dl className="kv">
          <dt>State</dt>
          <dd className={status?.pid ? "ok" : "warn"}>{state}</dd>
          <dt>Installed</dt>
          <dd>
            {text(status?.provider)}, concurrency {text(status?.concurrency)}
          </dd>
          <dt>Program</dt>
          <dd className="mono">{Array.isArray(status?.program) ? text(status.program[0]) : "—"}</dd>
          <dt>Logs</dt>
          <dd className="mono">
            {text(logs?.stdout)}
            <br />
            {text(logs?.stderr)}
          </dd>
        </dl>
        <div className="row">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as ExecutorProvider)}
            aria-label="Provider"
          >
            {(["fake", "claude", "codex"] as const).map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={64}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            aria-label="Concurrency"
          />
          <button
            disabled={busy}
            onClick={() => void act(() => window.hive.executor.start({ provider, concurrency }))}
          >
            Start
          </button>
          <button disabled={busy} onClick={() => void act(window.hive.executor.stop)}>
            Stop
          </button>
        </div>
      </div>
    </>
  );
};
