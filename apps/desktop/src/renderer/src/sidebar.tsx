// The Slack-style sidebar (UI-04): workspace name, "Find a conversation…", the view rows, then Starred (pinned),
// the user's groups, Channels, Direct messages, Bots and Hidden. Pinned / hidden / groups are the user's `sidebar_prefs` document on
// the server; section collapse is local (localStorage).
import type { SidebarPrefs } from "@hive/contracts";
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Inlines, type Names } from "./chat.tsx";
import { parseInline } from "@hive/ui-text";
import { Avatar, Icon, Menu, type Row, text } from "./ui.tsx";

export type View =
  | "channel"
  | "threads"
  | "inbox"
  | "activity"
  | "approvals"
  | "search"
  | "memory"
  | "status";
type Item = SidebarPrefs["pinned"][number];
type Target = { section: "pinned" } | { section: "group"; name: string };

const views = [
  ["threads", "Threads"],
  ["inbox", "Inbox"],
  ["activity", "Activity"],
  ["approvals", "Approvals"],
  ["search", "Search"],
  ["memory", "Memory"],
  ["status", "Status"],
] as const;
const sectionsKey = "hive.sidebarSections";
const same = (a: Item) => (b: Item) => a.kind === b.kind && a.id === b.id;

/** The document without `item` anywhere (pinned, hidden, groups). */
const without = (prefs: SidebarPrefs, item: Item): SidebarPrefs => ({
  pinned: prefs.pinned.filter((i) => !same(item)(i)),
  hidden: prefs.hidden.filter((i) => !same(item)(i)),
  groups: prefs.groups.map((g) => ({ ...g, items: g.items.filter((i) => !same(item)(i)) })),
});

/** `item` moved into `target` before `before` (or last). An item lives in one place: Starred, a group or Hidden. */
const place = (prefs: SidebarPrefs, item: Item, target: Target, before?: Item): SidebarPrefs => {
  const rest = without(prefs, item);
  const insert = (items: Item[]) => {
    const at = before ? items.findIndex(same(before)) : -1;
    return at < 0 ? [...items, item] : items.toSpliced(at, 0, item);
  };
  if (target.section === "pinned") return { ...rest, pinned: insert(rest.pinned) };
  const exists = rest.groups.some((g) => g.name === target.name);
  return {
    ...rest,
    groups: exists
      ? rest.groups.map((g) => (g.name === target.name ? { ...g, items: insert(g.items) } : g))
      : [...rest.groups, { name: target.name, items: [item] }],
  };
};

/** Pin, or unpin a pinned item (the menu's Pin / Unpin and the channel header's star). */
export const togglePin = (prefs: SidebarPrefs, item: Item) =>
  prefs.pinned.some(same(item)) ? without(prefs, item) : place(prefs, item, { section: "pinned" });

const readCollapsed = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(sectionsKey) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
};

export const Sidebar = (props: {
  workspaceName: string;
  prefs: SidebarPrefs;
  /** Saves the document. */
  update: (prefs: SidebarPrefs) => void;
  collapsed: boolean;
  toggleCollapsed: () => void;
  channels: Row[];
  /** The user's DMs (`id` = conversation id, `botId`, `name` = the Bot's). */
  dms: Row[];
  bots: Row[];
  names: Names;
  view: View;
  setView: (view: View) => void;
  /** The open conversation: a Channel or a DM. */
  current: { kind: "channel" | "dm"; id: string };
  openChannel: (id: string) => void;
  /** Opens (or creates) the Bot's DM: a Bot or DM row was clicked. */
  openDm: (botId: string) => void;
  approvals: number;
  /** The signed-in user (`GET /v1/me`): the account avatar at the bottom. */
  account: { id: string; label: string } | null;
  /** The account menu's Sign out, after the confirm dialog (`hive logout`). */
  signOut: () => void;
}) => {
  const { prefs, collapsed } = props;
  const [accountMenu, setAccountMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ item: Item; x: number; y: number } | null>(null);
  const [sections, setSections] = useState(readCollapsed);
  const dragged = useRef<Item | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const save = props.update;
  const toggleSection = (key: string, fallback: boolean) => {
    const next = { ...sections, [key]: !(sections[key] ?? fallback) };
    setSections(next);
    try {
      localStorage.setItem(sectionsKey, JSON.stringify(next));
    } catch {
      // Storage unavailable: section state is not remembered.
    }
  };

  const rows = new Map<string, Row>([
    ...props.channels.map((c) => [`channel:${c.id}`, c] as const),
    ...props.dms.map((d) => [`dm:${d.id}`, d] as const),
    ...props.bots.map((b) => [`bot:${b.id}`, b] as const),
  ]);
  const needle = query.trim().toLowerCase();
  /** Known (a deleted Channel / Bot is skipped, not removed from the document) and matching the filter. */
  const visible = (items: Item[]) =>
    items.filter((i) => {
      const row = rows.get(`${i.kind}:${i.id}`);
      return row && String(row.name).toLowerCase().includes(needle);
    });
  const placed = new Set(
    [...prefs.pinned, ...prefs.hidden, ...prefs.groups.flatMap((g) => g.items)].map(
      (i) => `${i.kind}:${i.id}`,
    ),
  );
  const loose = (kind: Item["kind"], list: Row[]) =>
    visible(list.map((r) => ({ kind, id: r.id })).filter((i) => !placed.has(`${i.kind}:${i.id}`)));

  const drop = (target: Target, before?: Item) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const item = dragged.current;
    dragged.current = null;
    if (item && !(before && same(item)(before))) save(place(prefs, item, target, before));
  };
  const dropZone = (target: Target) => ({
    onDragOver: (e: DragEvent) => e.preventDefault(),
    onDrop: drop(target),
  });

  const itemRow = (item: Item, target?: Target) => {
    const row = rows.get(`${item.kind}:${item.id}`)!;
    const name = text(row.name);
    const label = item.kind === "channel" ? `# ${name}` : name;
    const botId = item.kind === "dm" ? String(row.botId) : item.id;
    const { current } = props;
    const open = rows.get(`${current.kind}:${current.id}`);
    const active =
      props.view === "channel" &&
      (item.kind === "bot"
        ? current.kind === "dm" && open?.botId === item.id
        : item.kind === current.kind && item.id === current.id);
    const last = row.lastMessage as { body: string } | null | undefined;
    return (
      <li
        key={`${item.kind}:${item.id}`}
        className="item"
        draggable
        onDragStart={() => (dragged.current = item)}
        {...(target ? { onDragOver: (e) => e.preventDefault(), onDrop: drop(target, item) } : {})}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ item, x: e.clientX, y: e.clientY });
        }}
      >
        <button
          className={active ? "active" : ""}
          {...(collapsed ? { "data-tip": label } : {})}
          {...(item.kind === "bot" ? { "aria-label": name } : {})}
          onClick={() =>
            item.kind === "channel" ? props.openChannel(item.id) : props.openDm(botId)
          }
        >
          <Avatar
            id={item.kind === "channel" ? item.id : botId}
            name={String(row.name)}
            size={collapsed ? 36 : 32}
          />
          {!collapsed && (
            <span className="conv-text">
              <span className="ellipsis">{label}</span>
              {item.kind !== "bot" && (
                <span className="preview ellipsis">
                  {last ? (
                    <Inlines
                      inlines={parseInline(
                        last.body
                          .split("\n")[0]!
                          .replace(/^\s*([-*]|\d+[.)])\s+/, "")
                          .replaceAll(/\*\*|`/g, ""),
                      )}
                      names={props.names}
                    />
                  ) : (
                    "No messages yet"
                  )}
                </span>
              )}
            </span>
          )}
        </button>
        {!collapsed && (
          <button
            className="icon item-more"
            aria-label={`${label} actions`}
            aria-haspopup="menu"
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setMenu({ item, x: box.left, y: box.bottom + 4 });
            }}
          >
            <Icon name="more" />
          </button>
        )}
      </li>
    );
  };

  /** A header that collapses its list; `fallback` is the state before the user toggled it. */
  const section = (
    key: string,
    label: string,
    items: Item[],
    options: { fallback?: boolean; target?: Target; empty?: ReactNode } = {},
  ) => {
    if (items.length === 0 && (needle || collapsed || !options.empty)) return null;
    const closed = !needle && (sections[key] ?? options.fallback ?? false);
    return (
      <section
        key={key}
        className="side-section"
        {...(options.target ? dropZone(options.target) : {})}
      >
        {collapsed ? (
          <hr />
        ) : (
          <button
            className="section-head"
            aria-expanded={!closed}
            onClick={() => toggleSection(key, options.fallback ?? false)}
          >
            <span className={`caret ${closed ? "closed" : ""}`}>
              <Icon name="chevron" />
            </span>
            {label}
          </button>
        )}
        {(!closed || collapsed) &&
          (items.length === 0 ? (
            !collapsed && <p className="hint">{options.empty}</p>
          ) : (
            <ul className="convs">{items.map((i) => itemRow(i, options.target))}</ul>
          ))}
      </section>
    );
  };

  const hidden = visible(prefs.hidden);
  const menuItem = menu?.item;
  const pinned = menuItem ? prefs.pinned.some(same(menuItem)) : false;
  const isHidden = menuItem ? prefs.hidden.some(same(menuItem)) : false;
  const group = menuItem ? prefs.groups.find((g) => g.items.some(same(menuItem))) : undefined;

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="side-top">
        {!collapsed && (
          <span className="workspace ellipsis">
            {props.workspaceName} <Icon name="chevron" />
          </span>
        )}
        <button
          className="icon tip-below"
          data-tip={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label="Toggle sidebar"
          onClick={props.toggleCollapsed}
        >
          <Icon name="sidebar" />
        </button>
      </div>
      {!collapsed && (
        <label className="find">
          <Icon name="search" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a conversation…"
            aria-label="Find a conversation"
          />
        </label>
      )}
      <div className="side-scroll">
        <nav className="side-nav">
          {views.map(([v, label]) => (
            <button
              key={v}
              className={v === props.view ? "active" : ""}
              {...(collapsed ? { "data-tip": label } : {})}
              aria-label={label}
              onClick={() => props.setView(v)}
            >
              <Icon name={v} />
              {!collapsed && <span>{label}</span>}
              {v === "approvals" && props.approvals > 0 && (
                <span className="count" aria-label={`${props.approvals} pending`}>
                  {props.approvals}
                </span>
              )}
            </button>
          ))}
        </nav>
        {section("pinned", "Starred", visible(prefs.pinned), {
          target: { section: "pinned" },
          empty: "Drag and drop important stuff here",
        })}
        {prefs.groups.map((g) =>
          section(`group:${g.name}`, g.name, visible(g.items), {
            target: { section: "group", name: g.name },
          }),
        )}
        {section("channels", "Channels", loose("channel", props.channels))}
        {section("dms", "Direct messages", loose("dm", props.dms))}
        {section("bots", "Bots", loose("bot", props.bots))}
        {!collapsed && section("hidden", `Hidden (${hidden.length})`, hidden, { fallback: true })}
      </div>
      <div className="side-foot">
        <button
          className="account"
          aria-label="Account"
          aria-haspopup="menu"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            setAccountMenu({ x: box.left, y: box.top - 8 });
          }}
        >
          <Avatar
            id={props.account?.id ?? ""}
            name={props.account?.label ?? "?"}
            size={collapsed ? 36 : 32}
            plain
          />
        </button>
      </div>
      {accountMenu && (
        <Menu {...accountMenu} up close={() => setAccountMenu(null)}>
          <button
            role="menuitem"
            onClick={() => {
              setAccountMenu(null);
              props.setView("status");
            }}
          >
            <Icon name="settings" /> Settings
          </button>
          <hr />
          <button
            role="menuitem"
            onClick={() => {
              setAccountMenu(null);
              setConfirming(true);
            }}
          >
            <Icon name="logout" /> Sign out
          </button>
        </Menu>
      )}
      {confirming && (
        <SignOutDialog
          cancel={() => setConfirming(false)}
          confirm={() => {
            setConfirming(false);
            props.signOut();
          }}
        />
      )}
      {menu && menuItem && (
        <ItemMenu
          {...menu}
          close={closeMenu}
          pinned={pinned}
          hidden={isHidden}
          group={group?.name}
          groups={prefs.groups.map((g) => g.name)}
          act={(next) => {
            setMenu(null);
            save(next(prefs, menuItem));
          }}
        />
      )}
    </aside>
  );
};

/** Pin / Unpin, Move to group (inline), Copy ID, Hide / Show. No Delete: there is no `channel.delete` command. */
const ItemMenu = (props: {
  item: Item;
  x: number;
  y: number;
  close: () => void;
  pinned: boolean;
  hidden: boolean;
  group: string | undefined;
  groups: string[];
  act: (next: (prefs: SidebarPrefs, item: Item) => SidebarPrefs) => void;
}) => {
  const [moving, setMoving] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const { act } = props;
  const toGroup = (name: string) => act((p, i) => place(p, i, { section: "group", name }));
  return (
    <Menu x={props.x} y={props.y} close={props.close}>
      <button role="menuitem" onClick={() => act(togglePin)}>
        <Icon name={props.pinned ? "unpin" : "pin"} /> {props.pinned ? "Unpin" : "Pin"}
      </button>
      <button role="menuitem" aria-expanded={moving} onClick={() => setMoving(!moving)}>
        <Icon name="folder" /> Move to group <span className="submenu-caret">▸</span>
      </button>
      {moving && (
        <div className="submenu">
          {props.groups
            .filter((g) => g !== props.group)
            .map((g) => (
              <button key={g} role="menuitem" onClick={() => toGroup(g)}>
                {g}
              </button>
            ))}
          {naming === null ? (
            <button role="menuitem" onClick={() => setNaming("")}>
              New group…
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (naming.trim()) toGroup(naming.trim());
              }}
            >
              <input
                autoFocus
                maxLength={80}
                value={naming}
                onChange={(e) => setNaming(e.target.value)}
                placeholder="Group name"
                aria-label="Group name"
              />
            </form>
          )}
          {props.group && (
            <button role="menuitem" onClick={() => act(without)}>
              Remove from group
            </button>
          )}
        </div>
      )}
      <hr />
      <button
        role="menuitem"
        onClick={() => {
          void navigator.clipboard.writeText(props.item.id);
          props.close();
        }}
      >
        <Icon name="copy" /> Copy ID
      </button>
      <hr />
      <button
        role="menuitem"
        onClick={() =>
          act((p, i) =>
            props.hidden ? without(p, i) : { ...without(p, i), hidden: [...p.hidden, i] },
          )
        }
      >
        <Icon name={props.hidden ? "show" : "hide"} />{" "}
        {props.hidden ? "Show in sidebar" : "Hide from sidebar"}
      </button>
    </Menu>
  );
};

/** The in-app "Sign out?" confirm (the reference app's dialog); Escape or the backdrop cancels. */
const SignOutDialog = (props: { cancel: () => void; confirm: () => void }) => {
  const { cancel } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);
  return (
    <div className="dialog-backdrop" onClick={cancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sign-out-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="sign-out-title">Sign out?</h2>
        <p>
          Signing out removes the Access login from this computer. Your Channels, Bots and the
          executor service stay: the service keeps running with this device&apos;s token until you
          remove it with <code>hive executor uninstall</code>.
        </p>
        <div className="dialog-actions">
          <button className="pill-dark" onClick={cancel}>
            Cancel
          </button>
          <button className="pill-light" autoFocus onClick={props.confirm}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
};
