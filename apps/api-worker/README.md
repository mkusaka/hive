# @hive/api-worker

The Access-protected API Worker (Hono on Cloudflare Workers, D1 binding `DB`). See
[docs/architecture.md §18 and §22](../../docs/architecture.md#18-authentication-authorization-secrets-21).

## Routes

| Route                 | Auth                                   | Purpose                                        |
| --------------------- | -------------------------------------- | ---------------------------------------------- |
| `GET /healthz`        | none                                   | Liveness                                       |
| `GET /v1/me`          | Access assertion (user)                | Returns the user principal (CLI login check)   |
| `POST /v1/commands`   | Access assertion (user)                | Command intake: `workspace.create`, `device.*` |
| `GET /v1/executor/me` | `Authorization: Bearer <device-token>` | Returns the device principal                   |

- **User auth.** `Cf-Access-Jwt-Assertion` is verified with `jose` against
  `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (issuer `https://<ACCESS_TEAM_DOMAIN>`, audience
  `ACCESS_AUD`). `(issuer, sub)` maps to a `users` row, created on first login with the email claim.
- **Device auth.** The token is `<deviceId>.<secret>`. Only SHA-256(secret) is stored in `device_credentials`; it
  is compared in constant time, and a revoked credential or device is rejected.
- **Commands.** The envelope `{operationId, idempotencyKey, workspaceId, command}` and command schemas live in
  `@hive/contracts`. Membership of `workspaceId` is required (403 otherwise). Each command runs inside
  `withOperationReceipt`, so a replay with the same key returns the stored response and a different payload under
  the same key is 409 `IDEMPOTENCY_CONFLICT`.
- **`device.register` returns the plaintext token once.** The receipt stores the response with
  `deviceToken: null`; only the first execution adds the token. A lost token means registering a new device.
- **`workspace.create` is a dev bootstrap.** It is allowed only for a user with no memberships; the envelope's
  `workspaceId` becomes the new Workspace and the caller its owner.
- **Errors** use the `ApiError` shape and `apiErrorStatus` from `@hive/contracts`. Every response carries an
  `X-Request-Id` header (`cf-ray`, or a generated UUID), which error bodies repeat as `requestId`.

## Local development

`wrangler.jsonc` has a **placeholder `database_id`** (all zeros) until the owner provisions D1
(`bunx wrangler d1 create hive`) and replaces it. Local dev uses a local D1 and does not need the real id.

Create `apps/api-worker/.dev.vars` (gitignored) to fill the vars left empty in `wrangler.jsonc`:

```sh
ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com  # Access team domain, no scheme
ACCESS_AUD=<aud-tag>                            # Application Audience (AUD) tag of the Access app
```

```sh
cd apps/api-worker
bunx wrangler d1 migrations apply hive --local   # applies packages/db/migrations
bunx wrangler dev
```

Without Cloudflare Access in front, requests need a real Access assertion, so local dev is mostly useful for
`/healthz` and device-token routes. Tests sign assertions with a local key instead (`createApp({ jwks })`).

## Tests

`bun run test` from the repo root runs `test/` in miniflare with the `packages/db` migrations applied.
