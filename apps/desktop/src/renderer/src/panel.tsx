// The Bot panel (Details / Library / Computer) and the executor service section of the Computer tab.
import { useCallback, useEffect, useState } from "react";
import type { ExecutorProvider, UiCommand } from "../../shared/api.ts";
import { type Schedule, scheduleLine } from "./format.ts";
import { Avatar, failure, Icon, inWorkspace, MemoryList, type Row, text } from "./ui.tsx";

type Tab = "details" | "library" | "computer";

export const BotPanel = (props: {
  ws: string;
  bot: Row;
  devices: Row[];
  refreshDevices: () => void;
  close: () => void;
}) => {
  const [tab, setTab] = useState<Tab>("details");
  const [routines, setRoutines] = useState<Row[]>([]);
  const [memories, setMemories] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { ws, bot, refreshDevices } = props;

  const loadRoutines = useCallback(async () => {
    const res = await window.hive.api.get(inWorkspace("routines", ws, { botId: bot.id }));
    if (!res.ok) return setError(failure(res));
    setRoutines(res.value.routines as Row[]);
  }, [ws, bot.id]);
  useEffect(() => {
    setError(null);
    if (tab === "details") void loadRoutines();
    if (tab === "library")
      void window.hive.api
        .get(inWorkspace("memories", ws, { scopeKind: "bot", scopeId: bot.id }))
        .then((res) =>
          res.ok ? setMemories(res.value.memories as Row[]) : setError(failure(res)),
        );
    // Heartbeats write no change rows, so online state is refetched when the tab opens.
    if (tab === "computer") refreshDevices();
  }, [tab, ws, bot.id, loadRoutines, refreshDevices]);

  const routineCommand = async (
    type: "routine.pause" | "routine.resume" | "routine.run",
    id: string,
  ) => {
    const res = await window.hive.api.command({
      operationId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      workspaceId: ws,
      command: { type, routineId: id } as UiCommand["command"],
    });
    if (!res.ok) return setError(failure(res));
    void loadRoutines();
  };

  return (
    <aside className="panel">
      <div className="panel-top">
        <button className="round" title="Close" aria-label="Close" onClick={props.close}>
          <Icon name="close" />
        </button>
      </div>
      <div className="panel-id">
        <Avatar id={bot.id} name={String(bot.name)} size={88} />
        <h2>{text(bot.name)}</h2>
      </div>
      <div className="tabs" role="tablist">
        {(["details", "library", "computer"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={t === tab}
            className={t === tab ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
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
          <div className="card">
            {routines.length === 0 && <p className="meta">No routines.</p>}
            {routines.map((r) => (
              <div key={r.id} className="routine">
                <div>
                  <div className="ellipsis">{text(r.name)}</div>
                  <div className="meta ellipsis">{scheduleLine(r.schedule as Schedule)}</div>
                </div>
                <button
                  className="small"
                  title="Run now"
                  onClick={() => void routineCommand("routine.run", r.id)}
                >
                  Run now
                </button>
                <label className="switch" title={r.enabled ? "On" : "Off"}>
                  <input
                    type="checkbox"
                    checked={Boolean(r.enabled)}
                    aria-label={`${text(r.name)} enabled`}
                    onChange={() =>
                      void routineCommand(r.enabled ? "routine.pause" : "routine.resume", r.id)
                    }
                  />
                  <span />
                </label>
              </div>
            ))}
          </div>
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
    </aside>
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
      <div className="card">
        {status?.registered === false && (
          <p className="warn">this device is not registered: run `hive device register`</p>
        )}
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
