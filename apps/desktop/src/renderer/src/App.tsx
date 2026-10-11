// Phase 2 UI slice: Channel / Inbox / Activity (with the Run Inspector) / Approvals / Search / Memory / Devices views
// and a status bar (docs/architecture.md §21).
/* oxlint-disable no-await-in-loop */
import { useCallback, useEffect, useRef, useState } from "react";
import type { HiveConfig } from "../../shared/api.ts";
import { createSync, type ListKey, type SyncStatus } from "./sync.ts";

type Row = Record<string, unknown> & { id: string };
type View = "channel" | "inbox" | "activity" | "approvals" | "search" | "memory" | "devices";

const get = async (path: string) => {
  const result = await window.hive.api.get(path);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const inWorkspace = (resource: string, workspaceId: string, query: Record<string, string> = {}) =>
  `/v1/${resource}?${new URLSearchParams({ workspaceId, ...query })}`;
const text = (value: unknown) => (value === null || value === undefined ? "—" : String(value));

const Badge = ({ state }: { state: unknown }) => (
  <span className={`badge ${text(state)}`}>{text(state)}</span>
);

export const App = () => {
  const [config, setConfig] = useState<HiveConfig | null>(null);
  const [view, setView] = useState<View>("channel");
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState("reconnecting");
  const [sync, setSync] = useState<SyncStatus>({ cursor: null, unsynced: 0, error: null });

  const [channels, setChannels] = useState<Row[]>([]);
  const [messages, setMessages] = useState<Row[]>([]);
  const [bots, setBots] = useState<Row[]>([]);
  const [inbox, setInbox] = useState<Row[]>([]);
  const [jobs, setJobs] = useState<Row[]>([]);
  const [devices, setDevices] = useState<Row[]>([]);
  const [approvals, setApprovals] = useState<Row[]>([]);
  const [channelId, setChannelId] = useState("");
  const [botId, setBotId] = useState("");
  const [jobDetail, setJobDetail] = useState<Record<string, unknown> | null>(null);
  const [runId, setRunId] = useState("");
  const [run, setRun] = useState<Inspected | null>(null);

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
  const selection = useRef({ channelId, botId, runId });
  selection.current = { channelId, botId, runId };

  const refetch = useCallback(async (keys: Set<ListKey>, ws: string) => {
    const { channelId: ch, botId: bot, runId: inspected } = selection.current;
    const tasks: Promise<void>[] = [];
    if (keys.has("run") && inspected) tasks.push(inspect(inspected).then(setRun));
    const load = (key: ListKey, path: string | null, field: string, set: (rows: Row[]) => void) => {
      if (keys.has(key) && path) tasks.push(get(path).then((body) => set(body[field] as Row[])));
    };
    load("channels", inWorkspace("channels", ws), "channels", setChannels);
    load("bots", inWorkspace("bots", ws), "bots", setBots);
    load("devices", inWorkspace("devices", ws), "devices", setDevices);
    load("jobs", inWorkspace("jobs", ws, { limit: "50" }), "jobs", setJobs);
    load(
      "approvals",
      inWorkspace("approvals", ws, { state: "pending" }),
      "approvals",
      setApprovals,
    );
    // Newest first from the API, shown oldest first.
    load(
      "messages",
      ch && inWorkspace(`channels/${encodeURIComponent(ch)}/messages`, ws),
      "messages",
      (rows) => setMessages(rows.toReversed()),
    );
    load("inbox", bot && `/v1/inbox?${new URLSearchParams({ botId: bot })}`, "items", setInbox);
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
    });
    return off;
  }, []);

  useEffect(() => {
    if (!config || config.problem) return;
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

  // Selection changes load their list directly.
  useEffect(() => {
    if (config && !config.problem && channelId)
      void refetch(new Set(["messages"]), config.workspaceId);
  }, [config, channelId, refetch]);
  useEffect(() => {
    if (config && !config.problem && botId) void refetch(new Set(["inbox"]), config.workspaceId);
  }, [config, botId, refetch]);
  useEffect(() => {
    setRun(null);
    if (config && !config.problem && runId) void refetch(new Set(["run"]), config.workspaceId);
  }, [config, runId, refetch]);
  useEffect(() => {
    if (!channelId && channels[0]) setChannelId(channels[0].id);
    if (!botId && bots[0]) setBotId(bots[0].id);
  }, [channels, bots, channelId, botId]);

  if (!config) return <p className="pad">Loading…</p>;
  if (config.problem) return <p className="pad error">{config.problem}</p>;
  const ws = config.workspaceId;

  const botPicker = (
    <select value={botId} onChange={(e) => setBotId(e.target.value)} aria-label="Bot">
      {bots.map((b) => (
        <option key={b.id} value={b.id}>
          {text(b.name)}
        </option>
      ))}
    </select>
  );

  return (
    <div className="app">
      <nav>
        {(
          ["channel", "inbox", "activity", "approvals", "search", "memory", "devices"] as const
        ).map((v) => (
          <button key={v} className={v === view ? "active" : ""} onClick={() => setView(v)}>
            {v[0]!.toUpperCase() + v.slice(1)}
            {v === "approvals" && approvals.length > 0 && (
              <span className="count" aria-label={`${approvals.length} pending`}>
                {approvals.length}
              </span>
            )}
          </button>
        ))}
      </nav>
      <main>
        {error && <p className="error">{error}</p>}
        {view === "channel" && (
          <ChannelView
            ws={ws}
            channels={channels}
            channelId={channelId}
            setChannelId={setChannelId}
            messages={messages}
            botId={botId}
            botPicker={botPicker}
          />
        )}
        {view === "inbox" && (
          <section>
            <h2>Inbox {botPicker}</h2>
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
          <section className="split">
            <div>
              <h2>Jobs</h2>
              <ul className="list">
                {jobs.map((j) => (
                  <li key={j.id}>
                    <button
                      onClick={() =>
                        void get(`/v1/jobs/${encodeURIComponent(j.id)}`).then(setJobDetail, (e) =>
                          setError(String(e)),
                        )
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
            </div>
            <div>
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
              {run && <RunInspector run={run} />}
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
              setView("channel");
            }}
          />
        )}
        {view === "memory" && <MemoryView ws={ws} channels={channels} bots={bots} />}
        {view === "devices" && (
          <section>
            <h2>Devices</h2>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>OS</th>
                  <th>Last heartbeat</th>
                  <th>Revoked</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id}>
                    <td>{text(d.name)}</td>
                    <td>{text(d.os)}</td>
                    <td>{text(d.lastHeartbeatAt)}</td>
                    <td>{text(d.revokedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </main>
      <footer>
        <span>workspace {ws}</span>
        <span className={connection === "connected" ? "ok" : "warn"}>WS {connection}</span>
        <span className="mono" title={sync.cursor ?? ""}>
          cursor {sync.cursor ? `${sync.cursor.slice(-12)}` : "—"}
        </span>
        <span>unsynced hints {sync.unsynced}</span>
        {sync.error && <span className="error">{sync.error}</span>}
      </footer>
    </div>
  );
};

type Inspected = {
  detail: Record<string, unknown>;
  /** Null when the transcript is not readable (not a member of the Run's channel, or a bot-pair Run). */
  entries: { seq: number; kind: string; text: string; toolName?: string }[] | null;
  error: string | null;
};

/** `GET /v1/runs/:id` and every confirmed page of its normalized transcript (a page is one ≤ 1 MiB part). */
const inspect = async (id: string): Promise<Inspected> => {
  const run = `/v1/runs/${encodeURIComponent(id)}`;
  const detail = await get(run);
  const entries: NonNullable<Inspected["entries"]> = [];
  try {
    for (let cursor: unknown = "0"; typeof cursor === "string";) {
      const page = await get(`${run}/transcript?${new URLSearchParams({ cursor })}`);
      entries.push(...(page.entries as typeof entries));
      cursor = page.nextCursor;
    }
    return { detail, entries, error: null };
  } catch (error) {
    return { detail, entries: null, error: String(error) };
  }
};

/** Run Inspector (§21): state, transcript persistence, provider session presence and the normalized transcript. */
const RunInspector = ({ run }: { run: Inspected }) => {
  const d = run.detail;
  const transcript = d.transcript as { parts: number; confirmedThroughSeq: number | null };
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
      {d.resultError ? <p className="error">{text(d.resultError)}</p> : null}
      {d.resultSummary ? <p>{text(d.resultSummary)}</p> : null}
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

/** Pending approvals, newest first. The command is a device-side redacted summary; the full input never leaves it. */
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
    <section>
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

type Operation = { operationId: string; jobId: string | null; error?: string };

const ChannelView = (props: {
  ws: string;
  channels: Row[];
  channelId: string;
  setChannelId: (id: string) => void;
  messages: Row[];
  botId: string;
  botPicker: React.ReactNode;
}) => {
  const [draft, setDraft] = useState("");
  const [op, setOp] = useState<Operation | null>(null);

  const send = async () => {
    const operationId = crypto.randomUUID();
    const result = await window.hive.api.command({
      operationId,
      idempotencyKey: crypto.randomUUID(),
      workspaceId: props.ws,
      command: {
        type: "agent.send",
        recipientBotId: props.botId,
        channelId: props.channelId,
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

  return (
    <section className="split">
      <ul className="list">
        {props.channels.map((c) => (
          <li key={c.id}>
            <button
              className={c.id === props.channelId ? "active" : ""}
              onClick={() => props.setChannelId(c.id)}
            >
              # {text(c.name)}
            </button>
          </li>
        ))}
      </ul>
      <div className="channel">
        <ol className="messages">
          {props.messages.map((m) => (
            <li key={m.id}>
              <span className="meta">
                {text(m.createdAt)} <span className="mono">{text(m.actorId)}</span>
              </span>
              <div>{text(m.body)}</div>
            </li>
          ))}
        </ol>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {props.botPicker}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Message the Bot"
          />
          <button disabled={!draft || !props.botId || !props.channelId}>Send</button>
        </form>
        {op && (
          <p className="op">
            operation <span className="mono">{op.operationId}</span>:{" "}
            {op.error ??
              (op.jobId ? (
                <>
                  job <span className="mono">{op.jobId}</span>
                </>
              ) : (
                "accepted, routing pending"
              ))}
          </p>
        )}
      </div>
    </section>
  );
};

const failure = (result: { ok: false; error: { code: string; message: string } }) =>
  `${result.error.code}: ${result.error.message}`;

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
    <section>
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
    <section>
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
      <ul className="list">
        {memories.map((m) => (
          <li key={m.id}>
            <span className="meta">{text(m.createdAt)}</span> {text(m.content)}
          </li>
        ))}
      </ul>
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
