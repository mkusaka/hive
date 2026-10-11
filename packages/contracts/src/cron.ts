// 5-field cron (minute hour day-of-month month day-of-week) in an IANA timezone (docs/architecture.md §17.2).
// Numbers, `*`, lists, ranges and steps; no names or `L`/`W`/`#`. Minute precision. DST: a local time that does not
// exist is skipped, a repeated local time fires once (its first instant).
const MINUTE = 60_000;
const DAY = 86_400_000;
const bounds = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

const parseField = (text: string, [min, max]: readonly [number, number]) => {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`invalid cron field: ${text}`);
    const lo = m[1] ? min : Number(m[2]);
    const hi = m[1] || (m[3] === undefined && m[4] !== undefined) ? max : Number(m[3] ?? m[2]);
    const step = Number(m[4] ?? 1);
    if (lo < min || hi > max || lo > hi || step < 1)
      throw new Error(`cron field out of range: ${text}`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
};

export type Cron = ReturnType<typeof parseCron>;

/** Throws on an invalid expression. */
export const parseCron = (expr: string) => {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron needs 5 fields");
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, bounds[i]!)) as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  if (dow.has(7)) dow.add(0);
  // Classic cron: when both day fields are restricted, either one matching is enough.
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domAny: parts[2]!.startsWith("*"),
    dowAny: parts[4]!.startsWith("*"),
  };
};

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock minute of instant `ms` in `timeZone`, encoded as UTC milliseconds. Throws on an unknown zone. */
const wallClock = (ms: number, timeZone: string) => {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, format);
  }
  const p: Record<string, number> = {};
  for (const { type, value } of format.formatToParts(ms)) p[type] = Number(value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
};

export const isTimeZone = (timeZone: string) => {
  try {
    wallClock(0, timeZone);
    return true;
  } catch {
    return false;
  }
};

const dayMatches = (c: Cron, d: Date) => {
  const dom = c.dom.has(d.getUTCDate());
  const dow = c.dow.has(d.getUTCDay());
  if (c.domAny || c.dowAny) return (c.domAny || dom) && (c.dowAny || dow);
  return dom || dow;
};

/** First matching wall-clock minute at or after `from`; null when none within the search bound. */
const nextWall = (c: Cron, from: number) => {
  let t = from;
  for (let i = 0; i < 20_000; i++) {
    const d = new Date(t);
    const [y, m, day, h] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()];
    if (!c.month.has(m + 1)) t = Date.UTC(y, m + 1, 1);
    else if (!dayMatches(c, d)) t = Date.UTC(y, m, day + 1);
    else if (!c.hour.has(h)) t = Date.UTC(y, m, day, h + 1);
    else if (!c.minute.has(d.getUTCMinutes())) t += MINUTE;
    else return t;
  }
  return null;
};

/** The earliest instant showing wall clock `wall`, or null in a DST gap. Offsets change at most once a day. */
const toInstant = (wall: number, timeZone: string) => {
  const found = [wall - DAY, wall, wall + DAY]
    .map((probe) => wall - (wallClock(probe, timeZone) - Math.floor(probe / MINUTE) * MINUTE))
    .filter((at) => wallClock(at, timeZone) === wall);
  return found.length > 0 ? Math.min(...found) : null;
};

/** The first occurrence strictly after `after` (UTC ms), or null if the expression never matches. */
export const nextCron = (cron: Cron, timeZone: string, after: number) => {
  let from = wallClock(after, timeZone) + MINUTE;
  for (let i = 0; i < 1_000; i++) {
    const wall = nextWall(cron, from);
    if (wall === null) return null;
    const at = toInstant(wall, timeZone);
    // A repeated wall clock already fired at its first instant.
    if (at !== null && at > after) return at;
    from = wall + MINUTE;
  }
  return null;
};
