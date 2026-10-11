// Shared renderer helpers: API access, small presentational pieces (badge, avatar blob, stroke icons).
import { avatarColor } from "./format.ts";

export type Row = Record<string, unknown> & { id: string };

export const get = async (path: string) => {
  const result = await window.hive.api.get(path);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
export const inWorkspace = (
  resource: string,
  workspaceId: string,
  query: Record<string, string> = {},
) => `/v1/${resource}?${new URLSearchParams({ workspaceId, ...query })}`;
export const text = (value: unknown) =>
  value === null || value === undefined ? "—" : String(value);
export const failure = (result: { ok: false; error: { code: string; message: string } }) =>
  `${result.error.code}: ${result.error.message}`;

export const Badge = ({ state }: { state: unknown }) => (
  <span className={`badge ${text(state)}`}>{text(state)}</span>
);

/** hive has no avatar images: a blob in the id's color with the name's first letter; `plain` (users) is a grey circle. */
export const Avatar = (props: { id: string; name: string; size?: number; plain?: boolean }) => {
  const size = props.size ?? 36;
  return (
    <span
      className={`avatar ${props.plain ? "plain" : ""}`}
      aria-hidden
      style={{
        ...(props.plain ? {} : { background: avatarColor(props.id) }),
        width: size,
        height: size,
        fontSize: size * 0.42,
      }}
    >
      {props.name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
};

const icons = {
  sidebar: "M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z M9 4v16",
  inbox: "M3 13h5l1 3h6l1-3h5 M5.5 5h13L21 13v6H3v-6z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  approvals: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4",
  search: "M18 11a7 7 0 1 1-14 0a7 7 0 1 1 14 0 M16 16l5 5",
  memory: "M4 19V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h14",
  status: "M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0 M12 8v5 M12 16h.01",
  close: "M6 6l12 12 M18 6L6 18",
  copy: "M11 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z M5 15V5a2 2 0 0 1 2-2h8",
  send: "M12 19V5 M5 12l7-7 7 7",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  pause: "M9 5v14 M15 5v14",
  play: "M7 5l12 7-12 7z",
  edit: "M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4",
  trash: "M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3",
};

export const Icon = ({ name }: { name: keyof typeof icons }) => (
  <svg
    viewBox="0 0 24 24"
    width={18}
    height={18}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={icons[name]} />
  </svg>
);

/** Memories newest first (the Memory view and the Bot panel's Library tab). */
export const MemoryList = ({ memories }: { memories: Row[] }) => (
  <ul className="list">
    {memories.map((m) => (
      <li key={m.id}>
        <span className="meta">{text(m.createdAt)}</span> {text(m.content)}
      </li>
    ))}
  </ul>
);
