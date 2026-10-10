# Architecture decision records

Decisions recorded to avoid re-litigating them (§34). Changing one requires a new ADR.

| ADR    | Decision                                                        | Reason                                                                |
| ------ | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| ADR-01 | Cloudflare is the source of truth for shared state              | One entry point for CLI / UI / Bots / PCs                             |
| ADR-02 | Local machines do execution and journaling                      | Keeps subscriptions, PC resources and safe stop local                 |
| ADR-03 | Bot-to-bot goes through the cloud even on the same PC           | Durable inbox, permissions, audit, placement independence             |
| ADR-04 | D1 is the source of truth; DO is for realtime                   | Keeps wr-like relational queries and search                           |
| ADR-05 | Queues are delivery, not the Job database                       | The app manages long offline periods and retries                      |
| ADR-06 | Command / Event / Hook / Signal are separate                    | Different contracts for authorization, ordering, blocking, durability |
| ADR-07 | Task, Run and Session are separate                              | Multiple jobs per conversation, retries, native actors                |
| ADR-08 | Job and root Run attempt are separate                           | PC failover never overwrites history                                  |
| ADR-09 | FTS is a derived index                                          | Easier rebuild, permissions and retention                             |
| ADR-10 | Native transcript and normalized history are separate           | Exact resume and search/redaction have different needs                |
| ADR-11 | Shared offline execution is not supported initially             | Avoids double claims and double side effects                          |
| ADR-12 | Bots manage Subscriptions; humans manage the permission ceiling | Flexible watching with a bounded ceiling                              |
| ADR-13 | No cloud LLM initially                                          | Keeps billing path and privacy explicit                               |
| ADR-14 | An unknown writer's lock is not released by lease expiry alone  | Network loss is not process stop                                      |
| ADR-15 | Full event sourcing / Cordis / Workflows are not required       | Avoids duplicating state management and the provider loop             |

## What v1.0 fixed (§35)

- `Run` alone no longer represents intake and retry; `Job` is separate from the actor invocation.
- Normal CLI use and bot-to-bot messaging go through the cloud; shared offline execution is not even an exception
  in the initial implementation.
- `event.emit` (pub/sub) and `agent.send` (direct delivery) are separate.
- Atomic updates on D1 are concrete, avoiding the misconception that a 0-row CAS rolls back automatically.
- Unresolved writer reservations are separate from lease expiry.
- A durable local journal, separate from the SDK mirror, is mandatory.
- Raw provider transcripts are not casually redacted or indexed; opaque archive and normalized projection are
  separate.
- Summarization, memory extraction and semantic classification are local Jobs, not implicit LLM calls in cloud
  Workers.
- Derived data inherits ACLs so private sources do not leak into shared Memory or other Channels.
- Android does not depend on always-on WebSocket; push and foreground sync are separate.

**The implementation core is `CommandService + Event/Inbox + Job claim + Local Journal`.** Channels, Tasks,
integrations and long-term Memory are built on top of it.
