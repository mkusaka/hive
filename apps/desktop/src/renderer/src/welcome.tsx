// The Welcome screen (full window, before the app): API URL on first run, Sign in (Access Managed OAuth in the
// system browser), Choose / Create a workspace, Set up this PC. Each step saves to the shared credentials file through
// main and re-reads the config, which decides the next step.
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { ApiResult, HiveConfig } from "../../shared/api.ts";
import { failure } from "./ui.tsx";

/** Pointy-top hexagon around (x, y). */
const hex = (x: number, y: number, r: number) =>
  Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 3) * k - Math.PI / 2;
    return `${(x + r * Math.cos(a)).toFixed(2)},${(y + r * Math.sin(a)).toFixed(2)}`;
  }).join(" ");
// A seven-cell honeycomb: the center and its six neighbours (cell pitch 10, drawn at 9 for the gaps).
const cells = [
  [36, 36],
  [18.68, 36],
  [53.32, 36],
  [27.34, 21],
  [44.66, 21],
  [27.34, 51],
  [44.66, 51],
] as const;
const Mark = () => (
  <svg className="mark" width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
    {cells.map(([x, y]) => (
      <polygon key={`${x},${y}`} points={hex(x, y, 9)} fill="currentColor" />
    ))}
  </svg>
);

/** A Workspace id from its name, with a random suffix so two "Team"s do not collide. */
const slug = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  }-${crypto.randomUUID().slice(0, 6)}`;

/** `hive device register` from the app, then the service reconcile (Welcome's last step and the Computer tab). */
export const SetUpPc = (props: { onDone: () => void; onSkip?: () => void }) => {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.hive.getConfig().then((c) => setName((n) => n || c.hostname));
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const result = await window.hive.registerDevice({ name });
    setBusy(false);
    if (!result.ok) return setError(failure(result));
    props.onDone();
  };
  return (
    <form className="card setup-pc" onSubmit={(e) => void submit(e)}>
      <h3>Set up this PC</h3>
      <p className="muted">Register this PC so your Bots can run work on it in the background.</p>
      <label>
        PC name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <div className="row">
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? "Setting up…" : "Set up this PC"}
        </button>
        {props.onSkip && (
          <button type="button" className="link" onClick={props.onSkip}>
            Skip for now
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
};

export const Welcome = (props: {
  config: HiveConfig;
  /** Re-reads the config after a step. */
  reload: () => Promise<void>;
  /** "Skip for now" on Set up this PC: the app opens without a registered device. */
  skipDevice: () => void;
}) => {
  const { config, reload } = props;
  const [apiUrl, setApiUrl] = useState(config.apiUrl || config.defaultApiUrl);
  const [editingUrl, setEditingUrl] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  // Cancel only stops waiting: a later browser callback still saves the grant (README Known gaps).
  const attempt = useRef(0);

  /** A step's IPC call: shows its error, else re-reads the config. Returns whether it worked. */
  const step = async (call: () => Promise<ApiResult>) => {
    setBusy(true);
    const result = await call();
    setBusy(false);
    if (!result.ok) {
      setError(failure(result));
      return false;
    }
    setError(null);
    return true;
  };
  const signIn = async () => {
    const mine = ++attempt.current;
    setWaiting(true);
    setError(null);
    const result = await window.hive.login();
    if (mine !== attempt.current) return;
    setWaiting(false);
    if (!result.ok) return setError(result.message);
    await reload();
  };
  const saveUrl = async (e: FormEvent) => {
    e.preventDefault();
    if (!(await step(() => window.hive.setConfig({ apiUrl })))) return;
    setEditingUrl(false);
    // Dev (HIVE_ACCESS_JWT) needs no browser login.
    if ((await window.hive.getConfig()).loginRequired) return signIn();
    await reload();
  };
  const choose = async (workspaceId: string) => {
    if (await step(() => window.hive.setConfig({ workspaceId }))) await reload();
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const workspaceId = slug(name);
    const created = await step(() =>
      window.hive.api.command({
        operationId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        workspaceId,
        command: { type: "workspace.create", name: name.trim() },
      }),
    );
    if (created) await choose(workspaceId);
  };

  const host = (() => {
    try {
      return new URL(config.apiUrl).host;
    } catch {
      return "";
    }
  })();

  let body;
  if (!config.apiUrl || editingUrl)
    body = (
      <form className="welcome-form" onSubmit={(e) => void saveUrl(e)}>
        <label>
          API URL
          <input
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            placeholder="https://api.example.com"
            required
          />
        </label>
        <button type="submit" className="pill-cta" disabled={busy || !apiUrl.trim()}>
          Sign in →
        </button>
      </form>
    );
  else if (config.loginRequired)
    body = waiting ? (
      <div className="welcome-form">
        <button type="button" className="pill-cta" disabled>
          Waiting for the browser…
        </button>
        <button
          type="button"
          className="link"
          onClick={() => {
            attempt.current++;
            setWaiting(false);
          }}
        >
          Cancel
        </button>
      </div>
    ) : (
      <button type="button" className="pill-cta" onClick={() => void signIn()}>
        Sign in →
      </button>
    );
  else if (!config.workspaceId && config.workspaces.length > 0)
    body = (
      <div className="welcome-form">
        <h2>Choose a workspace</h2>
        <ul className="workspaces">
          {config.workspaces.map((w) => (
            <li key={w.id}>
              <button type="button" disabled={busy} onClick={() => void choose(w.id)}>
                <span>{w.name}</span>
                <span className="muted">{w.id}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  else if (!config.workspaceId && !config.problem)
    body = (
      <form className="welcome-form" onSubmit={(e) => void create(e)}>
        <h2>Create a workspace</h2>
        <label>
          Workspace name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <button type="submit" className="pill-cta" disabled={busy || !name.trim()}>
          Create →
        </button>
      </form>
    );
  else if (config.workspaceId)
    body = <SetUpPc onDone={() => void reload()} onSkip={props.skipDevice} />;

  return (
    <div className="welcome">
      <div className="welcome-main">
        <div className="brand">
          <Mark />
          <h1>hive</h1>
        </div>
        <p className="tagline">Your team of always-on Bots, working on your own PCs</p>
        {body}
        {(error ?? config.problem) && <p className="error">{error ?? config.problem}</p>}
      </div>
      {host && !editingUrl && (
        <footer className="welcome-foot">
          {host}{" "}
          <button type="button" className="link" onClick={() => setEditingUrl(true)}>
            Change
          </button>
        </footer>
      )}
    </div>
  );
};
