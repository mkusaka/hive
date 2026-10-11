// Cloudflare Access Managed OAuth for humans (docs/architecture.md §18.1): RFC 9728 resource metadata from the
// WWW-Authenticate header, OAuth discovery, dynamic client registration on a loopback redirect, PKCE, refresh.
// Access turns `Authorization: Bearer <access token>` into the `Cf-Access-Jwt-Assertion` the Worker verifies.
// Node only (loopback server, browser opener): used by src/main.ts and the Electron main process.
import { isInvalidGrant, prepareLogin, refresh, type OAuthToken } from "@hive/access";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { CliError } from "./client.ts";

export type OpenBrowser = (url: string) => Promise<void>;

/** Loopback callback on 127.0.0.1; the OS picks the port. */
const callbackServer = async () => {
  let resolve!: (url: URL) => void;
  const callback = new Promise<URL>((r) => (resolve = r));
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("hive: login complete. You can close this window.");
    resolve(new URL(req.url ?? "/", "http://127.0.0.1"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("could not bind the loopback callback server");
  }
  return {
    callback,
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    close: () => server.close(),
  };
};

/** Full browser login against the Access application in front of `apiUrl`. */
export const login = async (apiUrl: string, openBrowser: OpenBrowser): Promise<OAuthToken> => {
  const { callback, redirectUri, close } = await callbackServer();
  try {
    const prepared = await prepareLogin(apiUrl, redirectUri);
    await openBrowser(prepared.authorizationUrl);
    return await prepared.complete((await callback).href);
  } finally {
    close();
  }
};

/** The access token if it is good for at least 30 more seconds. */
const usable = (token: OAuthToken | undefined) =>
  token && token.expiresAt > Date.now() + 30_000 ? token.accessToken : undefined;

/** `undefined` on `invalid_grant` (refresh token expired, revoked or already rotated); other errors propagate. */
const tryRefresh = (stored: OAuthToken) =>
  refresh(stored).catch((error: unknown) => {
    if (!isInvalidGrant(error)) throw error;
    return undefined;
  });

/** Not logged in, or the grant is gone: the user has to log in (CLI `hive login`, Electron's Login button). */
const loginRequired = (message: string) => new CliError("LOGIN_REQUIRED", 3, message);

/**
 * An access-token getter over the grant in the shared credentials file, which the CLI and Electron both read and
 * write. Every call re-reads the file, because the other client may have logged in or refreshed meanwhile. A token
 * is reused until 30 s before expiry, then refreshed silently and written back. Access rotates refresh tokens, so on
 * `invalid_grant` the file is read once more and a newer grant is used before giving up. Only then, and only for a
 * stored grant and with `openBrowser`, does a browser login start; otherwise it fails with LOGIN_REQUIRED.
 * Concurrent calls in one process share one attempt.
 */
export const accessTokens = (opts: {
  apiUrl: string;
  load(): Promise<OAuthToken | undefined>;
  save(token: OAuthToken): Promise<void>;
  openBrowser?: OpenBrowser;
}) => {
  let pending: Promise<string> | undefined;
  const next = async () => {
    const stored = await opts.load();
    const current = usable(stored);
    if (current) return current;
    let token: OAuthToken | undefined = stored ? await tryRefresh(stored) : undefined;
    if (stored && !token) {
      const latest = await opts.load();
      const theirs = usable(latest);
      if (theirs) return theirs;
      if (latest && latest.refreshToken !== stored.refreshToken) token = await tryRefresh(latest);
    }
    if (!token && stored && opts.openBrowser) token = await login(opts.apiUrl, opts.openBrowser);
    if (!token)
      throw loginRequired(
        stored ? "Access session expired: run `hive login`" : "not logged in: run `hive login`",
      );
    await opts.save(token);
    return token.accessToken;
  };
  return () =>
    (pending ??= next().finally(() => {
      pending = undefined;
    }));
};

/** Opens the system browser; the URL is printed first so a headless machine can copy it. */
export const systemBrowser =
  (print: (line: string) => void): OpenBrowser =>
  async (url) => {
    print(`Open this URL to log in to Cloudflare Access:\n${url}`);
    // explorer.exe, not `cmd /c start`: cmd would interpret `|` or `^` in the remote authorization endpoint.
    const command =
      process.platform === "win32"
        ? "explorer.exe"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";
    await new Promise<void>((resolve) => {
      const child = spawn(command, [url], { stdio: "ignore", detached: true });
      child.on("error", () => resolve());
      child.on("spawn", () => {
        child.unref();
        resolve();
      });
    });
  };
