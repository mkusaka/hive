// GitHub / Slack payload → Event envelope fields (docs/architecture.md §5.2, §15, §16). Only the normalized
// fields are kept: the raw payload (which for Slack carries `token` / `authorizations`) is never stored.

export type Normalized = {
  type: string;
  externalEventId: string;
  subject: { kind: string; id: string } | null;
  data: Record<string, unknown>;
  /** Second dedupe identity (events.logical_key). */
  logicalKey: string | null;
  /** The app's own post: stored, never routed (AT-27). */
  echo: boolean;
};

const name = /^[a-z][a-z0-9_]*$/;
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const num = (value: unknown) => (typeof value === "number" ? value : undefined);

type GitHubItem = {
  number?: unknown;
  labels?: { name?: unknown }[];
  pull_request?: unknown;
  head?: { ref?: unknown; sha?: unknown };
};
type GitHubRun = {
  head_branch?: unknown;
  head_sha?: unknown;
  check_suite?: { head_branch?: unknown };
};
type GitHubPayload = {
  action?: unknown;
  repository?: { id?: unknown };
  sender?: { login?: unknown };
  pull_request?: GitHubItem;
  issue?: GitHubItem;
  check_run?: GitHubRun;
  check_suite?: GitHubRun;
  workflow_run?: GitHubRun;
  ref?: unknown;
  after?: unknown;
};

/** `github.<event>.<action>` (no action: `github.<event>`). Returns null for a malformed event / action name. */
export const normalizeGitHub = (
  event: string,
  deliveryId: string,
  payload: GitHubPayload,
): Normalized | null => {
  const action = str(payload.action);
  if (!name.test(event) || (action !== undefined && !name.test(action))) return null;
  const item = payload.pull_request ?? payload.issue;
  const isPullRequest =
    payload.pull_request !== undefined || payload.issue?.pull_request !== undefined;
  const run = payload.check_run ?? payload.check_suite ?? payload.workflow_run;
  const ref = str(payload.ref);
  const repositoryId = num(payload.repository?.id);
  const number = num(item?.number);
  return {
    type: `github.${event}${action ? `.${action}` : ""}`,
    externalEventId: deliveryId,
    subject:
      repositoryId !== undefined && number !== undefined
        ? { kind: isPullRequest ? "pull_request" : "issue", id: `${repositoryId}#${number}` }
        : null,
    data: {
      repositoryId,
      number,
      action,
      sender: str(payload.sender?.login),
      labels: item?.labels?.map((l) => str(l.name)).filter((l) => l !== undefined),
      branch:
        str(payload.pull_request?.head?.ref) ??
        str(run?.head_branch) ??
        str(run?.check_suite?.head_branch) ??
        (ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined),
      headSha: str(payload.pull_request?.head?.sha) ?? str(run?.head_sha) ?? str(payload.after),
    },
    logicalKey: null,
    echo: false,
  };
};

export const maxTextBytes = 8 * 1024;

/** Cut at a UTF-8 byte budget without leaving a broken character. */
const capUtf8 = (text: string, max: number) => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  return new TextDecoder().decode(bytes.slice(0, max)).replace(/�$/, "");
};

type SlackEvent = {
  type?: unknown;
  subtype?: unknown;
  user?: unknown;
  channel?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
  text?: unknown;
};
export type SlackCallback = { team_id?: unknown; event_id?: unknown; event?: SlackEvent };

/**
 * `slack.<event type>`, except that a `message` mentioning the app (`<@botUserId>`) is typed `slack.app_mention`
 * instead of `slack.message`, so whichever of the two deliveries of one post arrives first, the stored Event is the
 * same; the second collapses on `slack:<team>:<channel>:<ts>` (AT-23). Subscribe to `slack.*` to see every post. Edits / deletes (`subtype`) get no logical key yet.
 */
export const normalizeSlack = (
  payload: SlackCallback,
  botUserId: string | null,
): Normalized | null => {
  const e = payload.event ?? {};
  const eventType = str(e.type);
  const eventId = str(payload.event_id);
  if (!eventType || !name.test(eventType) || !eventId) return null;
  const team = str(payload.team_id);
  const channel = str(e.channel);
  const ts = str(e.ts);
  const threadTs = str(e.thread_ts) ?? ts;
  const user = str(e.user);
  const text = str(e.text);
  const mentionsApp = botUserId !== null && text?.includes(`<@${botUserId}>`) === true;
  const post = (eventType === "app_mention" || eventType === "message") && e.subtype === undefined;
  return {
    type: eventType === "message" && mentionsApp ? "slack.app_mention" : `slack.${eventType}`,
    externalEventId: eventId,
    subject:
      channel && threadTs ? { kind: "slack_thread", id: `${team}:${channel}:${threadTs}` } : null,
    data: {
      slackTeamId: team,
      slackChannelId: channel,
      slackThreadTs: threadTs,
      slackTs: ts,
      slackUserId: user,
      subtype: str(e.subtype),
      text: text === undefined ? undefined : capUtf8(text, maxTextBytes),
    },
    logicalKey: post && team && channel && ts ? `slack:${team}:${channel}:${ts}` : null,
    echo: botUserId !== null && user === botUserId,
  };
};
