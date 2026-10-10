# hive

hive is a platform where **Bots** join **Channels** and do background work on your own PCs. A Bot has a role,
instructions, skills, tools, memory and a placement policy. Work is triggered by conversation, Tasks and external
events such as GitHub and Slack.

## The core picture

- **Cloudflare is the source of truth.** Workers, D1, R2, Queues and Durable Objects hold all shared state and
  coordinate execution.
- **PCs are executors.** A Local Executor on each PC claims Jobs over HTTPS and runs the Claude Agent SDK, Codex,
  Bash, Git and MCP.
- **Everything goes through the cloud API.** The `hive` CLI, Electron, Android, GitHub, Slack and bot-to-bot messages
  all use the same authorization, delivery and execution management. This holds even when the target PC is the
  one you are sitting at.

A WebSocket notification never starts work by itself. The executor must claim the Job over HTTPS, and the cloud
confirms the lease and execution generation.

## Concepts

These are never conflated.

| Concept        | Meaning                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| Channel        | Long-lived area of interest; home of conversation and shared context                       |
| Project        | Outcome goal or ongoing work group that collects Tasks                                     |
| Task           | Goal, assignee, requirements, completion criteria; lightweight status and a dependency DAG |
| Bot            | Persistent role, skills, memory, execution and placement policy                            |
| LogicalSession | Ongoing dialogue between a Bot and a Conversation, per lane                                |
| Inbox          | Durable inputs a Bot is asked to handle, processed per Conversation / Task lane            |
| Job            | A logical request to execute asynchronously; durable in D1                                 |
| Run            | A concrete actor invocation on a specific PC; one Job has many Run attempts                |
| Execution      | Record of a Run working on a specific Task                                                 |

## Documentation

- [docs/overview.md](docs/overview.md): product definition, requirements, non-goals and external dependency gates.
- [docs/architecture.md](docs/architecture.md): components, data model, delivery, execution, sync, security and
  the API / CLI contracts.
- [docs/adr.md](docs/adr.md): architecture decision records.
- [docs/roadmap.md](docs/roadmap.md): current status, defaults, verification gates, acceptance tests and phases.
- [docs/references.md](docs/references.md): primary sources.

## Development

Requires [Bun](https://bun.sh) (version pinned in `package.json` `packageManager`).

```sh
bun install
bun run typecheck
bun run lint
bun run format:check   # `bun run format` to fix
bun run test           # vitest across all workspace packages
```

Layout: Bun workspaces under `apps/*` and `packages/*`. Today `packages/contracts` holds the shared Valibot schemas
`packages/db` holds the D1 schema, migrations and atomic repository, `apps/api-worker` is the Access-protected
API Worker, `apps/executor` is the Local Executor (fake provider only) and `apps/cli` is the `hive` CLI. See
[docs/architecture.md](docs/architecture.md#25-monorepo-layout-and-dependency-direction-28) for the target layout.

## Try it locally

The Phase 1 loop, CLI → Cloud → PC → Cloud result, against a local Worker and D1. No Cloudflare account is
needed: `scripts/dev-token.ts` stands in for Access (see `apps/api-worker/README.md`).

```sh
# Terminal 1: the API Worker
cd apps/api-worker
bun scripts/dev-token.ts --dev-vars > .dev.vars
bunx wrangler d1 migrations apply hive --local
bunx wrangler dev --local

# Terminal 2: the CLI, from the repo root
alias hive='bun apps/cli/src/main.ts'
export HIVE_ACCESS_JWT=$(bun apps/api-worker/scripts/dev-token.ts)
hive workspace create --id ws-dev --name home --api-url http://localhost:8787
hive device register --name pc1 --os darwin --agent-version 0.0.0
hive channel create --name dev                 # note channelId
hive bot create --name coder                   # note botId
hive agent send <botId> --channel <channelId> --message 'check PR #123'
hive executor run --once                       # pumps the outbox, claims the Job, runs the fake provider
hive job watch <jobId>                         # jobId from the executor output; exits 0 on succeeded
```

`agent send ... --wait` instead blocks until the Job finishes; it needs an executor polling meanwhile (for
example `hive executor run` without `--once` in a third terminal).

Credentials (`apiUrl`, `workspaceId`, `deviceToken`) are stored in `~/.config/hive/credentials.json`; see
[apps/cli/README.md](apps/cli/README.md).

## License

[MIT](LICENSE)
