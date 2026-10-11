// Routine scheduler (docs/architecture.md §17.2). A tick turns due occurrences into an Inbox item and a queued Job;
// Routines never call a model. Driven by the cron trigger and `POST /v1/executor/pump` (pump.ts).
import { nextCron, parseCron, type RoutineSchedule } from "@hive/contracts";
import { appendChange, createJob, guard, insertEvent, insertInboxItem } from "@hive/db";

export type RoutineRow = {
  id: string;
  workspace_id: string;
  bot_id: string;
  conversation_id: string | null;
  channel_id: string | null;
  task_id: string | null;
  input_text: string;
  schedule: string;
  schedule_revision: number;
  misfire: "skip" | "coalesce";
  next_fire_at: string | null;
  enabled: number;
  revision: number;
};
export const routineColumns = `r.id, r.workspace_id, r.bot_id, r.conversation_id, c.channel_id, r.task_id,
  r.input_text, r.schedule, r.schedule_revision, r.misfire, r.next_fire_at, r.enabled, r.revision`;
export const routineFrom = `routines r
  LEFT JOIN conversations c ON c.workspace_id = r.workspace_id AND c.id = r.conversation_id`;

type Change = Omit<Parameters<typeof appendChange>[1], "workspaceId">;

/**
 * One Routine occurrence. A skipped one records only its durable history; a created one also writes the `routine.fired`
 * Event, Inbox item and queued Job. The occurrence key is the timer instant for scheduled work and a source identity
 * for immediate triggers, so AT-31 stays durable without collapsing a webhook burst that shares one millisecond.
 */
export const occurrenceStatements = (
  db: D1Database,
  r: RoutineRow,
  scheduledAt: string,
  input: { occurrenceKey?: string; payload?: unknown; skipped?: boolean } = {},
) => {
  const workspaceId = r.workspace_id;
  const [occurrenceId, eventId, inboxItemId, jobId] = [1, 2, 3, 4].map(() => crypto.randomUUID());
  const occurrenceKey = input.occurrenceKey ?? scheduledAt;
  if (input.skipped) {
    return {
      statements: [
        insertOccurrence(db, r, scheduledAt, null, occurrenceId, occurrenceKey, input.payload),
      ],
      changes: [] as Change[],
      occurrenceId: occurrenceId!,
      jobId: null,
    };
  }
  const inputText =
    input.payload === undefined
      ? r.input_text
      : `${r.input_text}\n\n\`\`\`json\n${JSON.stringify(input.payload, null, 2)}\n\`\`\``;
  const scope = r.channel_id ? `channel:${r.channel_id}` : `workspace:${workspaceId}`;
  const statements = [
    insertEvent(db, {
      id: eventId!,
      workspaceId,
      type: "routine.fired",
      schemaVersion: 1,
      sourceKind: "routine",
      actorKind: "system",
      actorId: `routine:${r.id}`,
      subjectKind: "routine",
      subjectId: r.id,
      data: {
        routineId: r.id,
        occurrenceId,
        scheduledAt,
        inputText,
        ...(input.payload === undefined ? {} : { payload: input.payload }),
      },
      correlationId: occurrenceId!,
      occurredAt: scheduledAt,
      receivedAt: new Date().toISOString(),
    }),
    insertInboxItem(db, {
      id: inboxItemId!,
      workspaceId,
      inputId: eventId!,
      botId: r.bot_id,
      lane: r.conversation_id ?? `routine:${r.id}`,
      purpose: "routine",
      conversationId: r.conversation_id,
      deliveryMode: "wake",
    }),
    createJob(db, {
      id: jobId!,
      workspaceId,
      botId: r.bot_id,
      triggerKey: `inbox:${inboxItemId}`,
      taskId: r.task_id ?? undefined,
    }),
    insertOccurrence(db, r, scheduledAt, jobId!, occurrenceId, occurrenceKey, input.payload),
  ];
  const changes: Change[] = [
    { entityKind: "inbox_item", entityId: inboxItemId!, scope },
    { entityKind: "job", entityId: jobId!, revision: 1, scope: `workspace:${workspaceId}` },
  ];
  return { statements, changes, occurrenceId: occurrenceId!, jobId: jobId! };
};

const insertOccurrence = (
  db: D1Database,
  r: RoutineRow,
  scheduledAt: string,
  jobId: string | null,
  id: string = crypto.randomUUID(),
  occurrenceKey: string = scheduledAt,
  payload?: unknown,
) =>
  db
    .prepare(
      `INSERT INTO routine_occurrences
         (id, workspace_id, routine_id, schedule_revision, scheduled_at, occurrence_key, payload, state, job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      r.workspace_id,
      r.id,
      r.schedule_revision,
      scheduledAt,
      occurrenceKey,
      payload === undefined ? null : JSON.stringify(payload),
      jobId ? "created" : "skipped",
      jobId,
    );

const iso = (ms: number) => new Date(ms).toISOString();
/** `skip`: an occurrence later than this is not run. */
export const routineSkipGraceMs = 5 * 60_000;
const maxRecorded = 50;
const maxMissed = 1440;

/**
 * Due times from `next_fire_at` up to `now`, and the next one after them.
 * ponytail: enumerates at most 1440 missed occurrences per tick (a day of a per-minute cron); past that the schedule
 * restarts from now and the rest are not recorded. Add bounded_catch_up with a cap per Routine if that matters.
 */
const dueTimes = (schedule: RoutineSchedule, nextFireAt: string, now: number) => {
  const due = [nextFireAt];
  if (schedule.kind === "once") return { due, next: null };
  if (schedule.kind !== "cron") return { due: [], next: null };
  const cron = parseCron(schedule.expr);
  for (let t = Date.parse(nextFireAt); ;) {
    const n = nextCron(cron, schedule.timezone, t);
    if (n === null || n > now) return { due, next: n === null ? null : iso(n) };
    if (due.length >= maxMissed) {
      const after = nextCron(cron, schedule.timezone, now);
      return { due, next: after === null ? null : iso(after) };
    }
    due.push(iso(n));
    t = n;
  }
};

/**
 * One tick: for every enabled Routine with `next_fire_at <= now`, one guarded batch creates the occurrences its
 * misfire policy runs (`coalesce`: the latest due one; `skip`: those at most 5 minutes late), records the others as
 * `skipped` (latest 50) and advances `next_fire_at` with a CAS on (schedule_revision, next_fire_at). A concurrent tick
 * loses on that CAS or the occurrence UNIQUE and is skipped. Returns the created Jobs.
 */
export const fireDueRoutines = async (db: D1Database, limit = 50) => {
  const now = Date.now();
  const { results } = await db
    .prepare(
      `SELECT ${routineColumns} FROM ${routineFrom}
        WHERE r.enabled = 1 AND r.next_fire_at <= ?
          AND (r.conversation_id IS NULL OR EXISTS (
            SELECT 1 FROM bots b JOIN channel_members m
              ON m.workspace_id = b.workspace_id AND m.actor_id = b.actor_id AND m.channel_id = c.channel_id
             WHERE b.workspace_id = r.workspace_id AND b.id = r.bot_id AND m.role <> 'viewer'
          ))
        ORDER BY r.next_fire_at LIMIT ?`,
    )
    .bind(iso(now), limit)
    .all<RoutineRow & { next_fire_at: string }>();
  const fired = await Promise.all(
    results.map((r) =>
      fireRoutine(db, r, now).catch((error: unknown) => {
        // One broken Routine must not stop the others; it is retried on the next tick.
        console.error(`routine ${r.id} tick failed`, error);
        return null;
      }),
    ),
  );
  return fired.filter((f) => f !== null);
};

const fireRoutine = async (
  db: D1Database,
  r: RoutineRow & { next_fire_at: string },
  now: number,
) => {
  const { due, next } = dueTimes(JSON.parse(r.schedule) as RoutineSchedule, r.next_fire_at, now);
  const recent = due.slice(-maxRecorded);
  // Already recorded (e.g. a `once` resumed after it fired) are left alone, so the batch cannot fail on them.
  const { results: seen } = await db
    .prepare(
      `SELECT scheduled_at FROM routine_occurrences WHERE routine_id = ? AND schedule_revision = ?
              AND scheduled_at IN (SELECT value FROM json_each(?))`,
    )
    .bind(r.id, r.schedule_revision, JSON.stringify(recent))
    .all<{ scheduled_at: string }>();
  const fresh = recent.filter((at) => !seen.some((s) => s.scheduled_at === at));
  const run =
    r.misfire === "coalesce"
      ? fresh.slice(-1)
      : fresh.filter((at) => now - Date.parse(at) <= routineSkipGraceMs);
  const created = run.map((at) => occurrenceStatements(db, r, at));
  const [setGuard, clearGuard] = guard(db);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE routines SET next_fire_at = ?, updated_at = ?
                WHERE id = ? AND enabled = 1 AND schedule_revision = ? AND next_fire_at = ?`,
        )
        .bind(next, iso(now), r.id, r.schedule_revision, r.next_fire_at),
      setGuard,
      clearGuard,
      ...created.flatMap((o) => [
        ...o.statements,
        ...o.changes.map((c) => appendChange(db, { workspaceId: r.workspace_id, ...c })),
      ]),
      ...fresh.filter((at) => !run.includes(at)).map((at) => insertOccurrence(db, r, at, null)),
    ]);
    return { workspaceId: r.workspace_id, jobIds: created.map((o) => o.jobId) };
  } catch (error) {
    const current = await db
      .prepare("SELECT schedule_revision, next_fire_at, enabled FROM routines WHERE id = ?")
      .bind(r.id)
      .first<{ schedule_revision: number; next_fire_at: string | null; enabled: number }>();
    const moved =
      current?.schedule_revision !== r.schedule_revision ||
      current.next_fire_at !== r.next_fire_at ||
      current.enabled !== 1;
    if (moved) return null;
    throw error;
  }
};
