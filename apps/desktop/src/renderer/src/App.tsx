// The desktop shell (docs/architecture.md §21): a sidebar of Bots and Channels, the Channel conversation, the Bot
// panel, and the Inbox / Activity (with the Run Inspector) / Approvals / Search / Memory / Status views.
/* oxlint-disable no-await-in-loop */
import type { SidebarPrefs } from "@hive/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HiveConfig } from "../../shared/api.ts";
import { ChannelView, ThreadPanel } from "./chat.tsx";
import { BotPanel, ChannelPanel, type ChannelTab } from "./panel.tsx";
import { Sidebar, togglePin, type View } from "./sidebar.tsx";
import { createSync, type ListKey, type SyncStatus } from "./sync.ts";
import { Badge, failure, get, inWorkspace, MemoryList, type Row, text } from "./ui.tsx";
import { Welcome } from "./welcome.tsx";

type SidebarDoc = { workspaceName: string; prefs: SidebarPrefs; revision: number };
const collapsedKey = "hive.sidebarCollapsed";
/** API URL, signed in and a Workspace: the data can load (the Welcome screen may still show Set up this PC). */
const isLive = (config: HiveConfig | null): config is HiveConfig =>
  config !== null && config.apiUrl !== "" && config.workspaceId !== "" && !config.loginRequired;

export const App = () => {
  const [config, setConfig] = useState<HiveConfig | null>(null);
  const [view, setView] = useState<View>("channel");
  const [error, setError] = useState<string | null>(null);
  // "Skip for now" on Set up this PC, for this window.
  const [skippedDevice, setSkippedDevice] = useState(false);
  const [connection, setConnection] = useState("reconnecting");
  const [sync, setSync] = useState<SyncStatus>({ cursor: null, unsynced: 0, error: null });

  const [channels, setChannels] = useState<Row[]>([]);
  const [dms, setDms] = useState<Row[]>([]);
  const [messages, setMessages] = useState<Row[]>([]);
  const [threads, setThreads] = useState<Row[]>([]);
  // The open Thread panel's replies, oldest first.
  const [replies, setReplies] = useState<Row[]>([]);
  const [bots, setBots] = useState<Row[]>([]);
  const [inbox, setInbox] = useState<Row[]>([]);
  const [externalRuns, setExternalRuns] = useState<Row[]>([]);
  const [sessionKind, setSessionKind] = useState<"jobs" | "external">("jobs");
  const [jobs, setJobs] = useState<Row[]>([]);
  const [devices, setDevices] = useState<Row[]>([]);
  const [approvals, setApprovals] = useState<Row[]>([]);
  const [channelId, setChannelId] = useState("");
  // The open DM's conversation id; it replaces the Channel in the conversation view while set.
  const [dmId, setDmId] = useState<string | null>(null);
  const [botId, setBotId] = useState("");
  const [jobDetail, setJobDetail] = useState<Record<string, unknown> | null>(null);
  const [runId, setRunId] = useState("");
  const [run, setRun] = useState<Inspected | null>(null);
  const [me, setMe] = useState<string | null>(null);
  // The account avatar's label (email, else id).
  const [meLabel, setMeLabel] = useState("");
  const [side, setSide] = useState<SidebarDoc>({
    workspaceName: "",
    prefs: { pinned: [], hidden: [], groups: [] },
    revision: 0,
  });
  // The revision the next sidebar.update expects: ahead of `side` while saves are in flight.
  const sideRevision = useRef(0);
  const saving = useRef(Promise.resolve());
  // One right panel at a time: a Bot's, the current Channel's, or a thread (null `conversationId` until its first reply).
  const [panel, setPanel] = useState<
    | { kind: "bot"; id: string }
    | { kind: "channel"; tab: ChannelTab }
    | ({ kind: "thread"; conversationId: string | null } & ThreadOpen)
    | null
  >(null);
  const thread = panel?.kind === "thread" ? panel : null;
  const panelBot = panel?.kind === "bot" ? panel.id : null;
  const openBot = useCallback((id: string | null) => setPanel(id ? { kind: "bot", id } : null), []);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(collapsedKey) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(collapsedKey, collapsed ? "1" : "0");
    } catch {
      // Storage unavailable: the sidebar state is not remembered.
    }
  }, [collapsed]);

  /** job.cancel (§9.3): an active Job keeps running until its executor stops it; sync shows the outcome. */
  const cancelJob = async (workspaceId: string, jobId: string) => {
    const result = await window.hive.api.command({
      operationId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      workspaceId,
      command: { type: "job.cancel", jobId },
    });
    if (!result.ok) setError(`${result.error.code}: ${result.error.message}`);
  };

  /** approval.resolve (§19): resolved once; a stale or already-resolved one is a 409 shown as an error. */
  const resolveApproval = async (
    workspaceId: string,
    approvalId: string,
    decision: "allow" | "deny",
  ) => {
    const result = await window.hive.api.command({
      operationId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      workspaceId,
      command: { type: "approval.resolve", approvalId, decision },
    });
    if (!result.ok) setError(`${result.error.code}: ${result.error.message}`);
    void refetch(new Set(["approvals"]), workspaceId);
  };

  // Refetches run from sync callbacks, so they read the current selection through refs.
  const threadId = thread?.conversationId ?? null;
  const selection = useRef({ channelId, dmId, botId, runId, threadId, sessionKind });
  selection.current = { channelId, dmId, botId, runId, threadId, sessionKind };

  const refetch = useCallback(async (keys: Set<ListKey>, ws: string) => {
    const {
      channelId: ch,
      dmId: dm,
      botId: bot,
      runId: inspected,
      threadId: th,
      sessionKind: sessions,
    } = selection.current;
    const tasks: Promise<void>[] = [];
    if (keys.has("run") && inspected) tasks.push(inspect(inspected).then(setRun));
    const load = (key: ListKey, path: string | null, field: string, set: (rows: Row[]) => void) => {
      if (keys.has(key) && path) tasks.push(get(path).then((body) => set(body[field] as Row[])));
    };
    load("channels", inWorkspace("channels", ws), "channels", setChannels);
    load("dms", inWorkspace("dms", ws), "dms", setDms);
    load("bots", inWorkspace("bots", ws), "bots", setBots);
    load("devices", inWorkspace("devices", ws), "devices", setDevices);
    load("jobs", inWorkspace("jobs", ws, { limit: "50" }), "jobs", setJobs);
    if (sessions === "external")
      load("jobs", inWorkspace("runs", ws, { kind: "external" }), "runs", setExternalRuns);
    load(
      "approvals",
      inWorkspace("approvals", ws, { state: "pending" }),
      "approvals",
      setApprovals,
    );
    // Newest first from the API, shown oldest first.
    const conversation = dm
      ? `conversations/${encodeURIComponent(dm)}`
      : ch && `channels/${encodeURIComponent(ch)}`;
    load(
      "messages",
      conversation && inWorkspace(`${conversation}/messages`, ws),
      "messages",
      (rows) => setMessages(rows.toReversed()),
    );
    load("threads", inWorkspace("threads", ws, { participant: "me" }), "threads", setThreads);
    if (keys.has("thread") && th)
      tasks.push(
        get(inWorkspace(`conversations/${encodeURIComponent(th)}/messages`, ws)).then((body) => {
          setReplies((body.messages as Row[]).toReversed());
          // The served root names its author's user ("You"); a Threads row's root does not.
          setPanel((p) =>
            p?.kind === "thread" && p.conversationId === th ? { ...p, root: body.root as Row } : p,
          );
        }),
      );
    load("inbox", bot && `/v1/inbox?${new URLSearchParams({ botId: bot })}`, "items", setInbox);
    if (keys.has("sidebar"))
      tasks.push(
        get(inWorkspace("sidebar", ws)).then((doc) => {
          sideRevision.current = Number(doc.revision);
          setSide(doc as SidebarDoc);
        }),
      );
    const failed = (await Promise.allSettled(tasks)).find((r) => r.status === "rejected");
    setError(failed ? String(failed.reason) : null);
  }, []);

  const syncRef = useRef<ReturnType<typeof createSync> | null>(null);
  useEffect(() => {
    // Subscribe before asking for config: the reply carries the connection state at that moment.
    const off = window.hive.onRealtime((event) => {
      if (event.type === "sync.changed") void syncRef.current?.hint();
      else {
        setConnection(event.state);
        if (event.state === "connected") void syncRef.current?.pull(); // reconcile on reconnect
      }
    });
    void window.hive.getConfig().then((c) => {
      setConfig(c);
      setConnection(c.connection);
      if (c.openBot) openBot(c.openBot);
    });
    return off;
  }, [openBot]);

  useEffect(() => {
    if (!isLive(config)) return;
    const controller = createSync({
      workspaceId: config.workspaceId,
      get: window.hive.api.get,
      refetch: (keys) => void refetch(keys, config.workspaceId),
      onStatus: setSync,
    });
    syncRef.current = controller;
    void controller.pull();
    // Reconcile about every 60 s with jitter, and on focus (docs/roadmap.md §1).
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => void controller.pull().then(schedule),
        50_000 + Math.random() * 20_000,
      );
    };
    schedule();
    const onFocus = () => void controller.pull();
    window.addEventListener("focus", onFocus);
    return () => {
      syncRef.current = null;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [config, refetch]);

  // Who "You" is in the message list (messages carry the author's user id) and the account avatar.
  useEffect(() => {
    if (isLive(config))
      void get("/v1/me").then(
        (p) => {
          setMe(String(p.userId));
          setMeLabel(text(p.label ?? p.userId));
        },
        () => setMe(null),
      );
  }, [config]);
  /**
   * Optimistic: shown at once, saved in order (each save expects the revision the previous one produced). A 409 means
   * another device changed it: the server's document is re-read and shown.
   */
  const updateSidebar = (next: SidebarPrefs) => {
    if (!config) return;
    const ws = config.workspaceId;
    // A group exists while it has items.
    const prefs = { ...next, groups: next.groups.filter((g) => g.items.length > 0) };
    setSide((s) => ({ ...s, prefs }));
    saving.current = saving.current.then(async () => {
      const res = await window.hive.api.command({
        operationId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        workspaceId: ws,
        command: { type: "sidebar.update", prefs, expectedRevision: sideRevision.current },
      });
      if (res.ok) {
        sideRevision.current = Number(res.value.revision);
        return setSide((s) => ({ ...s, revision: sideRevision.current }));
      }
      await refetch(new Set(["sidebar"]), ws);
      setError(
        res.error.code === "REVISION_CONFLICT"
          ? "The sidebar changed on another device; reloaded it."
          : failure(res),
      );
    });
  };
  /** The Bot's DM: the listed one, else `dm.open` creates it (idempotent) and the list is re-read first. */
  const openDm = async (id: string) => {
    if (!config) return;
    setView("channel");
    const listed = dms.find((d) => d.botId === id);
    if (listed) return setDmId(listed.id);
    const res = await window.hive.api.command({
      operationId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      workspaceId: config.workspaceId,
      command: { type: "dm.open", botId: id },
    });
    if (!res.ok) return setError(failure(res));
    await refetch(new Set(["dms"]), config.workspaceId);
    setDmId(String(res.value.conversationId));
  };
  const refreshDevices = useCallback(() => {
    if (config) void refetch(new Set(["devices"]), config.workspaceId);
  }, [config, refetch]);

  // Selection changes load their list directly.
  useEffect(() => {
    if (isLive(config) && channelId) void refetch(new Set(["messages"]), config.workspaceId);
  }, [config, channelId, dmId, refetch]);
  useEffect(() => {
    if (isLive(config) && botId) void refetch(new Set(["inbox"]), config.workspaceId);
  }, [config, botId, refetch]);
  useEffect(() => {
    setReplies([]);
    if (isLive(config) && threadId) void refetch(new Set(["thread"]), config.workspaceId);
  }, [config, threadId, refetch]);
  useEffect(() => {
    setRun(null);
    if (isLive(config) && runId) void refetch(new Set(["run"]), config.workspaceId);
  }, [config, runId, refetch]);
  useEffect(() => {
    if (sessionKind === "external" && isLive(config))
      void get(inWorkspace("runs", config.workspaceId, { kind: "external" })).then(
        (body) => setExternalRuns(body.runs as Row[]),
        (e) => setError(String(e)),
      );
  }, [config, sessionKind]);
  useEffect(() => {
    if (!channelId && channels[0]) setChannelId(channels[0].id);
    if (!botId && bots[0]) setBotId(bots[0].id);
  }, [channels, bots, channelId, botId]);

  if (!config) return <p className="pad">Loading…</p>;
  const reloadConfig = async () => setConfig(await window.hive.getConfig());
  if (!isLive(config) || (!config.deviceRegistered && !skippedDevice))
    return (
      <Welcome config={config} reload={reloadConfig} skipDevice={() => setSkippedDevice(true)} />
    );
  const ws = config.workspaceId;

  const panelBotRow = panelBot ? bots.find((b) => b.id === panelBot) : undefined;
  const dm = dmId ? dms.find((d) => d.id === dmId) : undefined;
  const channel = channels.find((c) => c.id === channelId);
  const botNames = new Map(bots.map((b) => [b.id, String(b.name)]));
  const channelPanel =
    panel?.kind === "channel" && view === "channel" && !dmId ? channel : undefined;
  const current = dmId
    ? { kind: "dm" as const, id: dmId }
    : { kind: "channel" as const, id: channelId };
  /** Opens a message's thread (the Bot / Channel panel closes); a Threads row also switches to its Channel / DM. */
  const openThread = (root: Row, conversationId: string | null, at: ThreadOpen["at"]) => {
    const bot = at.kind === "dm" ? dms.find((d) => d.id === at.id) : undefined;
    setChannelId(at.kind === "channel" ? at.id : channelId);
    setDmId(at.kind === "dm" ? at.id : null);
    setView("channel");
    setPanel({
      kind: "thread",
      conversationId,
      root,
      at,
      title:
        at.kind === "dm" ? text(bot?.name) : `#${text(channels.find((c) => c.id === at.id)?.name)}`,
    });
  };

  return (
    <div className={`app ${panelBotRow || channelPanel || thread ? "with-panel" : ""}`}>
      <Sidebar
        workspaceName={side.workspaceName}
        prefs={side.prefs}
        update={updateSidebar}
        collapsed={collapsed}
        toggleCollapsed={() => setCollapsed(!collapsed)}
        channels={channels}
        dms={dms}
        bots={bots}
        names={botNames}
        view={view}
        setView={setView}
        current={current}
        openChannel={(id) => {
          setChannelId(id);
          setDmId(null);
          setView("channel");
        }}
        openDm={(id) => void openDm(id)}
        approvals={approvals.length}
        account={me ? { id: me, label: meLabel } : null}
        signOut={() =>
          void window.hive
            .logout()
            .then((res) => (res.ok ? reloadConfig() : setError(failure(res))))
        }
      />
      <main>
        {error && <p className="error banner">{error}</p>}
        {view === "channel" && (
          <ChannelView
            ws={ws}
            channel={dmId ? dm : channel}
            dm={dmId !== null}
            messages={messages}
            bots={bots}
            me={me}
            openBot={openBot}
            openThread={(m) =>
              openThread(
                m,
                (m.thread as { conversationId?: string } | null)?.conversationId ?? null,
                current,
              )
            }
            toggleChannelPanel={() =>
              setPanel(channelPanel ? null : { kind: "channel", tab: "about" })
            }
            openChannelPanel={(tab) => setPanel({ kind: "channel", tab })}
            starred={side.prefs.pinned.some((i) => i.kind === current.kind && i.id === current.id)}
            toggleStar={() => updateSidebar(togglePin(side.prefs, current))}
          />
        )}
        {view === "threads" && (
          <section className="view">
            <h2>Threads</h2>
            {threads.length === 0 && <p className="muted">No threads yet.</p>}
            <ul className="list threads">
              {threads.map((t) => {
                const root = t.root as Row;
                return (
                  <li key={String(t.conversationId)}>
                    <button
                      onClick={() =>
                        openThread(root, String(t.conversationId), {
                          kind: t.parentKind === "dm" ? "dm" : "channel",
                          id: String(t.parentKind === "dm" ? t.parentConversationId : t.channelId),
                        })
                      }
                    >
                      <span className="muted">
                        {t.parentKind === "dm" ? "DM" : `#${text(t.channelName)}`}
                      </span>{" "}
                      <span className="ellipsis">{text(root.body)}</span>{" "}
                      <span className="muted">
                        {text(t.replyCount)} {t.replyCount === 1 ? "reply" : "replies"} · last reply{" "}
                        {new Date(String(t.lastReplyAt)).toLocaleString("en-US")}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {view === "inbox" && (
          <section className="view">
            <h2>
              Inbox{" "}
              <select value={botId} onChange={(e) => setBotId(e.target.value)} aria-label="Bot">
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    {text(b.name)}
                  </option>
                ))}
              </select>
            </h2>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Lane</th>
                  <th>Delivery</th>
                  <th>State</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {inbox.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.id}</td>
                    <td className="mono">{text(i.lane)}</td>
                    <td>{text(i.delivery)}</td>
                    <td>
                      <Badge state={i.state} />
                    </td>
                    <td>{text(i.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {view === "activity" && (
          <section className="view split">
            <div>
              <h2>Activity</h2>
              <div role="group" aria-label="Sessions">
                <button
                  className={sessionKind === "jobs" ? "active" : ""}
                  onClick={() => {
                    setSessionKind("jobs");
                    setRunId("");
                  }}
                >
                  Jobs
                </button>
                <button
                  className={sessionKind === "external" ? "active" : ""}
                  onClick={() => {
                    setSessionKind("external");
                    setJobDetail(null);
                    setRunId("");
                  }}
                >
                  External
                </button>
              </div>
              {sessionKind === "jobs" ? (
                <ul className="list">
                  {jobs.map((j) => (
                    <li key={j.id}>
                      <button
                        onClick={() =>
                          void get(`/v1/jobs/${encodeURIComponent(j.id)}`)
                            // A Task's Job also shows the Task's git rollup (GIT-01).
                            .then(async (job) =>
                              job.taskId
                                ? {
                                    ...job,
                                    task: await get(
                                      `/v1/tasks/${encodeURIComponent(String(job.taskId))}`,
                                    ),
                                  }
                                : job,
                            )
                            .then(setJobDetail, (e) => setError(String(e)))
                        }
                      >
                        <Badge state={j.state} /> <span className="mono">{j.id}</span>
                        {j.cancelRequestedAt ? " (cancel requested)" : ""}
                      </button>
                      {["queued", "waiting_device", "active"].includes(String(j.state)) &&
                        !j.cancelRequestedAt && (
                          <button onClick={() => void cancelJob(ws, j.id)}>Cancel</button>
                        )}
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="list">
                  {externalRuns.map((r) => (
                    <li key={r.id}>
                      <button
                        className={r.id === runId ? "active" : ""}
                        onClick={() => {
                          setJobDetail(null);
                          setRunId(r.id);
                        }}
                      >
                        <Badge state={r.state} /> {text(r.provider)}{" "}
                        <span className="mono" title={text(r.cwd)}>
                          {text(r.cwdLabel ?? r.cwd)
                            .split(/[\\/]/)
                            .findLast(Boolean) || text(r.cwd)}
                        </span>{" "}
                        {text(r.repository)} {text(r.title)} started {text(r.startedAt)} · last
                        activity {text(r.lastActivityAt)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              {jobDetail?.task ? (
                <TaskGit task={jobDetail.task as Record<string, unknown>} openRun={setRunId} />
              ) : null}
              {sessionKind === "jobs" && (
                <>
                  <pre>{jobDetail ? JSON.stringify(jobDetail, null, 2) : "Select a Job"}</pre>
                  {Array.isArray(jobDetail?.runs) && (
                    <ul className="list">
                      {(jobDetail.runs as Row[]).map((r) => (
                        <li key={r.id}>
                          <button
                            className={r.id === runId ? "active" : ""}
                            onClick={() => setRunId(r.id)}
                          >
                            Run {text(r.generation)} <Badge state={r.state} />{" "}
                            <span className="mono">{r.id}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {run && (
                <RunInspector
                  key={String(run.detail.id)}
                  run={run}
                  reload={() => void refetch(new Set(["run"]), ws)}
                />
              )}
            </div>
          </section>
        )}
        {view === "approvals" && (
          <ApprovalsView
            approvals={approvals}
            resolve={(id, d) => void resolveApproval(ws, id, d)}
          />
        )}
        {view === "search" && (
          <SearchView
            ws={ws}
            openChannel={(id) => {
              setChannelId(id);
              setDmId(null);
              setView("channel");
            }}
          />
        )}
        {view === "memory" && <MemoryView ws={ws} channels={channels} bots={bots} />}
        {view === "status" && (
          <section className="view">
            <h2>Status</h2>
            <dl className="kv">
              <dt>Workspace</dt>
              <dd className="mono">{ws}</dd>
              <dt>WebSocket</dt>
              <dd className={connection === "connected" ? "ok" : "warn"}>{connection}</dd>
              <dt>Sync cursor</dt>
              <dd className="mono" title={sync.cursor ?? ""}>
                {sync.cursor ? sync.cursor.slice(-12) : "—"}
              </dd>
              <dt>Unsynced hints</dt>
              <dd>{sync.unsynced}</dd>
            </dl>
            {sync.error && <p className="error">{sync.error}</p>}
          </section>
        )}
      </main>
      {panelBotRow && (
        <BotPanel
          ws={ws}
          bot={panelBotRow}
          bots={bots}
          channels={channels}
          devices={devices}
          refreshDevices={refreshDevices}
          close={() => setPanel(null)}
        />
      )}
      {thread && (
        <ThreadPanel
          ws={ws}
          title={thread.title}
          root={thread.root}
          replies={replies}
          target={
            thread.at.kind === "dm" ? { conversationId: thread.at.id } : { channelId: thread.at.id }
          }
          dmBot={
            thread.at.kind === "dm"
              ? String(dms.find((d) => d.id === thread.at.id)?.botId ?? "")
              : null
          }
          bots={bots}
          me={me}
          openBot={openBot}
          onPosted={(id) => {
            if (id === thread.conversationId) return void refetch(new Set(["thread"]), ws);
            setPanel({ ...thread, conversationId: id });
          }}
          close={() => setPanel(null)}
        />
      )}
      {channelPanel && (
        <ChannelPanel
          ws={ws}
          channel={channelPanel}
          bots={bots}
          me={me}
          defaultBotId={botId}
          openBot={openBot}
          refreshChannels={() => void refetch(new Set(["channels"]), ws)}
          close={() => setPanel(null)}
          tab={panel?.kind === "channel" ? panel.tab : "about"}
          setTab={(tab) => setPanel({ kind: "channel", tab })}
        />
      )}
    </div>
  );
};

/** What the Thread panel shows: the root message, where it lives and the header title. */
type ThreadOpen = { root: Row; at: { kind: "channel" | "dm"; id: string }; title: string };

type Inspected = {
  detail: Record<string, unknown>;
  /** Null when the transcript is not readable (not a member of the Run's channel, or a bot-pair Run). */
  entries: { seq: number; kind: string; text: string; toolName?: string }[] | null;
  error: string | null;
  /** The Run's external effects (§19). */
  effects: Row[];
};

/** `GET /v1/runs/:id` and every confirmed page of its normalized transcript (a page is one ≤ 1 MiB part). */
const inspect = async (id: string): Promise<Inspected> => {
  const run = `/v1/runs/${encodeURIComponent(id)}`;
  const detail = await get(run);
  const { effects } = await get(
    inWorkspace("effects", String(detail.workspaceId), { runId: String(detail.id) }),
  );
  const entries: NonNullable<Inspected["entries"]> = [];
  try {
    for (let cursor: unknown = "0"; typeof cursor === "string";) {
      const page = await get(`${run}/transcript?${new URLSearchParams({ cursor })}`);
      entries.push(...(page.entries as typeof entries));
      cursor = page.nextCursor;
    }
    return { detail, entries, error: null, effects: effects as Row[] };
  } catch (error) {
    return { detail, entries: null, error: String(error), effects: effects as Row[] };
  }
};

type Pr = { number: number; url: string; state: string; title: string };
type GitDetail = {
  repository: string;
  branch: string;
  partial: boolean;
  commits: { sha: string; subject: string; authoredAt: string }[];
  prs: Pr[];
  prError: string | null;
};

// PR links are plain text: the window denies opening links.
const PrList = ({ prs }: { prs: Pr[] }) => (
  <ul>
    {prs.map((pr) => (
      <li key={pr.url}>
        #{pr.number} <Badge state={pr.state} /> {pr.title} <span className="mono">{pr.url}</span>
      </li>
    ))}
  </ul>
);

/** The Run's commits and PRs from `git.collected` (GIT-01). */
const RunGit = ({ git }: { git: GitDetail }) => (
  <>
    <h4>
      Git <span className="mono">{git.repository || "(no remote)"}</span> ·{" "}
      <span className="mono">{git.branch}</span>
      {git.partial ? " · partial (commits since the Run started)" : ""}
    </h4>
    <ul>
      {git.commits.map((c) => (
        <li key={c.sha}>
          <span className="mono">{c.sha.slice(0, 12)}</span> {c.subject}
        </li>
      ))}
    </ul>
    <PrList prs={git.prs} />
    {git.prError ? <p className="error">PRs: {git.prError}</p> : null}
  </>
);

/** A Task's git rollup over its Runs (GIT-01). */
const TaskGit = ({
  task,
  openRun,
}: {
  task: Record<string, unknown>;
  openRun: (id: string) => void;
}) => {
  const git = task.git as { commits: number; prs: Pr[]; repositories: string[] };
  const externalSessions = (task.externalSessions as Row[] | undefined) ?? [];
  return (
    <section>
      <h4>
        Task {text(task.key)}: {git.commits} commits · {git.prs.length} PRs ·{" "}
        <span className="mono">{git.repositories.join(", ") || "—"}</span>
      </h4>
      <PrList prs={git.prs} />
      {externalSessions.length > 0 && (
        <>
          <h4>External sessions</h4>
          <ul className="list">
            {externalSessions.map((session) => (
              <li key={session.id}>
                <button onClick={() => openRun(session.id)}>
                  {text(session.provider)}{" "}
                  <span className="mono" title={text(session.cwd)}>
                    {text(session.cwdLabel ?? session.cwd)
                      .split(/[\\/]/)
                      .findLast(Boolean) || text(session.cwd)}
                  </span>{" "}
                  {text(session.title)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};

/** Run Inspector (§21): state, transcript persistence, provider session presence and the normalized transcript. */
const RunInspector = ({ run, reload }: { run: Inspected; reload: () => void }) => {
  const d = run.detail;
  const transcript = d.transcript as { parts: number; confirmedThroughSeq: number | null };
  const [tasks, setTasks] = useState<Row[]>([]);
  const [taskId, setTaskId] = useState(String(d.taskId ?? ""));
  const [linkError, setLinkError] = useState<string | null>(null);
  useEffect(() => {
    if (d.kind === "external")
      void get(inWorkspace("tasks", String(d.workspaceId))).then(
        (body) => setTasks(body.tasks as Row[]),
        (error) => setLinkError(String(error)),
      );
  }, [d.kind, d.workspaceId]);
  const linkTask = async () => {
    if (!taskId) return;
    const result = await window.hive.api.command({
      operationId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      workspaceId: String(d.workspaceId),
      command: { type: "run.link_task", runId: String(d.id), taskId },
    });
    if (result.ok) {
      setLinkError(null);
      reload();
    } else setLinkError(failure(result));
  };
  return (
    <section className="inspector">
      <h3>
        Run <span className="mono">{text(d.id)}</span> <Badge state={d.state} />{" "}
        <Badge state={d.persistence} />
      </h3>
      <p>
        generation {text(d.generation)} · device <span className="mono">{text(d.deviceId)}</span> ·
        started {text(d.startedAt)} · finished {text(d.finishedAt)} · provider session{" "}
        {d.hasProviderSession ? "yes" : "no"} · parts {transcript.parts} (confirmed through{" "}
        {text(transcript.confirmedThroughSeq)})
      </p>
      {d.kind === "external" && (
        <section>
          <h4>Link to Task</h4>
          {d.taskId ? <p>Linked Task {text(d.taskKey ?? d.taskId)}</p> : null}
          <select aria-label="Task" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">Choose a Task</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {text(task.key)}: {text(task.title)}
              </option>
            ))}
          </select>
          <button disabled={!taskId} onClick={() => void linkTask()}>
            Link to Task
          </button>
          {linkError ? <p className="error">{linkError}</p> : null}
        </section>
      )}
      {d.resultError ? <p className="error">{text(d.resultError)}</p> : null}
      {d.resultSummary ? <p>{text(d.resultSummary)}</p> : null}
      {run.effects.length > 0 && (
        <>
          <h4>Effects</h4>
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>State</th>
                <th>Request</th>
                <th>External</th>
                <th>Attempts</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {run.effects.map((e) => (
                <tr key={e.id}>
                  <td>{text(e.kind)}</td>
                  <td>
                    <Badge state={e.state} />
                  </td>
                  <td>
                    <pre className="mono">{text(e.summary)}</pre>
                  </td>
                  {/* Plain text: the window denies opening links. */}
                  <td className="mono">{text(e.externalUrl ?? e.externalId)}</td>
                  <td>{text(e.attempts)}</td>
                  <td className="error">{e.lastError ? text(e.lastError) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {d.git ? <RunGit git={d.git as GitDetail} /> : null}
      {run.entries === null ? (
        <p className="error">Transcript unavailable: {run.error}</p>
      ) : (
        <ol className="transcript">
          {run.entries.map((e, i) => (
            <li key={i}>
              <span className={`badge ${e.kind}`}>{e.kind}</span>
              {e.toolName ? <span className="mono"> {e.toolName}</span> : null}
              <pre>{e.text}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};

/**
 * Pending approvals, newest first. For a tool the arguments are a device-side redacted summary (the full input never
 * leaves it); for an external effect (`slack.post`, `github.comment`, where `cloud`) the target and text to be posted.
 */
const ApprovalsView = (props: {
  approvals: Row[];
  resolve: (approvalId: string, decision: "allow" | "deny") => void;
}) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expiresIn = (at: unknown) => {
    const s = Math.max(0, Math.round((Date.parse(String(at)) - now) / 1000));
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  };
  return (
    <section className="view">
      <h2>Approvals</h2>
      {props.approvals.length === 0 && <p>No pending approvals.</p>}
      <table>
        <thead>
          <tr>
            <th>Action</th>
            <th>Arguments</th>
            <th>Where</th>
            <th>Bot</th>
            <th>Expires in</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.approvals.map((a) => (
            <tr key={a.id}>
              <td>{text(a.actionKind)}</td>
              <td>
                <pre className="mono">{text(a.argsSummary)}</pre>
              </td>
              <td className="mono">{text(a.cwdLabel)}</td>
              <td>{text(a.botName)}</td>
              <td>{expiresIn(a.expiresAt)}</td>
              <td>
                <button onClick={() => props.resolve(a.id, "allow")}>Allow</button>{" "}
                <button onClick={() => props.resolve(a.id, "deny")}>Deny</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

/**
 * Full-text search (§14). Results come from a lagging projection, so `indexedThrough` is shown (AT-32); a message hit
 * opens its channel.
 */
const SearchView = (props: { ws: string; openChannel: (channelId: string) => void }) => {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    const res = await window.hive.api.get(inWorkspace("search", props.ws, { q }));
    if (!res.ok) return setError(failure(res));
    setError(null);
    setResult(res.value);
  };
  const hits = (result?.hits ?? []) as Row[];
  return (
    <section className="view">
      <h2>Search</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          aria-label="Query"
        />
        <button disabled={!q.trim()}>Search</button>
      </form>
      {error && <p className="error">{error}</p>}
      {result && <p className="meta">indexed through {text(result.indexedThrough)}</p>}
      <ul className="list">
        {hits.map((h) => {
          const scope = String(h.scope);
          const channel =
            h.sourceKind === "message" && scope.startsWith("channel:") ? scope.slice(8) : null;
          return (
            <li key={`${String(h.sourceKind)}:${String(h.sourceId)}`}>
              <button disabled={!channel} onClick={() => channel && props.openChannel(channel)}>
                <Badge state={h.sourceKind} /> {h.title ? `${text(h.title)} ` : ""}
                {text(h.snippet)}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

/** Memories of one scope (§13.6), newest first, and a form that writes one. */
const MemoryView = (props: { ws: string; channels: Row[]; bots: Row[] }) => {
  const [scope, setScope] = useState(`workspace:${props.ws}`);
  const [memories, setMemories] = useState<Row[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scopeKind, scopeId] = [
    scope.slice(0, scope.indexOf(":")),
    scope.slice(scope.indexOf(":") + 1),
  ];
  const load = useCallback(async () => {
    const res = await window.hive.api.get(
      inWorkspace("memories", props.ws, { scopeKind, scopeId }),
    );
    if (!res.ok) return setError(failure(res));
    setError(null);
    setMemories(res.value.memories as Row[]);
  }, [props.ws, scopeKind, scopeId]);
  useEffect(() => void load(), [load]);
  const write = async () => {
    const res = await window.hive.api.command({
      operationId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      workspaceId: props.ws,
      command: {
        type: "memory.write",
        scopeKind: scopeKind as "workspace",
        scopeId,
        content: draft,
      },
    });
    if (!res.ok) return setError(failure(res));
    setDraft("");
    void load();
  };
  return (
    <section className="view">
      <h2>
        Memory{" "}
        <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope">
          <option value={`workspace:${props.ws}`}>workspace</option>
          {props.channels.map((c) => (
            <option key={c.id} value={`channel:${c.id}`}>
              # {text(c.name)}
            </option>
          ))}
          {props.bots.map((b) => (
            <option key={b.id} value={`bot:${b.id}`}>
              bot {text(b.name)}
            </option>
          ))}
        </select>
      </h2>
      {error && <p className="error">{error}</p>}
      <MemoryList memories={memories} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void write();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Remember…"
          aria-label="Memory"
        />
        <button disabled={!draft}>Add</button>
      </form>
    </section>
  );
};
