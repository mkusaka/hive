// Shared renderer helpers: API access, small presentational pieces (badge, avatar blob, stroke icons, menu).
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { avatarColor } from "@hive/ui-text";

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
  thread: "M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20l1.1-5.4A8.5 8.5 0 1 1 21 11.5z",
  threads: "M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20l1.1-5.4A8.5 8.5 0 1 1 21 11.5z M8 10h8 M8 13.5h5",
  audit: "M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5",
  approvals: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4",
  search: "M18 11a7 7 0 1 1-14 0a7 7 0 1 1 14 0 M16 16l5 5",
  memory: "M4 19V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h14",
  status: "M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0 M12 8v5 M12 16h.01",
  close: "M6 6l12 12 M18 6L6 18",
  copy: "M11 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z M5 15V5a2 2 0 0 1 2-2h8",
  send: "M12 19V5 M5 12l7-7 7 7",
  reply: "M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 6 6v4",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  pause: "M9 5v14 M15 5v14",
  play: "M7 5l12 7-12 7z",
  edit: "M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4",
  trash: "M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z",
  pin: "M9 4h6 M10 4v6l-3 4h10l-3-4V4 M12 14v6",
  unpin: "M9 4h6 M10 4v6l-3 4h10l-3-4V4 M12 14v6 M4 4l16 16",
  hide: "M3 3l18 18 M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.4 M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.2 M9.9 9.9a3 3 0 0 0 4.2 4.2",
  show: "M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6z M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  chevron: "M6 9l6 6 6-6",
  settings:
    "M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0 M12 2v3 M12 19v3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M2 12h3 M19 12h3 M4.9 19.1L7 17 M17 7l2.1-2.1",
  logout: "M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4 M9 8l-4 4 4 4 M5 12h10",
  users:
    "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1 M13 7a4 4 0 1 1-8 0a4 4 0 1 1 8 0 M22 19v-1a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8",
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
    {memories.map((m) => {
      const mergedFrom = Array.isArray(m.mergedFromIds) ? m.mergedFromIds.length : 0;
      return (
        <li key={m.id}>
          <span className="meta">{text(m.createdAt)}</span> {text(m.content)}
          {m.source === "consolidation" && (
            <>
              {" "}
              <Badge state="consolidated" />
              <span className="meta"> merged from {mergedFrom}</span>
            </>
          )}
        </li>
      );
    })}
  </ul>
);

/**
 * A context menu at (x, y), kept inside the window, over a backdrop: a click outside, a right-click outside or Escape
 * closes it. Children are `role="menuitem"` buttons and `<hr />` separators. With `up`, (x, y) is its bottom-left
 * corner (the sidebar's account menu).
 */
export const Menu = (props: {
  x: number;
  y: number;
  up?: boolean;
  close: () => void;
  children: ReactNode;
}) => {
  const { x, close } = props;
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: x, top: props.y });
  // Measured on every render: the content can grow (an expanded submenu).
  useLayoutEffect(() => {
    const el = box.current!;
    const y = props.up ? props.y - el.offsetHeight : props.y;
    const left = Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 8));
    const top = Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 8));
    if (left !== at.left || top !== at.top) setAt({ left, top });
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <>
      <div
        className="backdrop"
        onClick={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <div ref={box} className="menu" role="menu" style={at}>
        {props.children}
      </div>
    </>
  );
};
