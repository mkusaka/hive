# infra

Terraform for the owner's Cloudflare resources: D1 database `hive`, R2 bucket `hive`, one Access Service Token per
executor PC, one Access application protecting the API Worker, and a path-specific bypass application for signed
Routine webhooks. Workers, bindings and deploys stay with Wrangler (docs/architecture.md §1); production uses
`https://hive-api.<subdomain>.workers.dev`, with no custom domain. The integration worker stays outside Access.

## Access application

- **Destinations.** Derive `hive-api.${workers_subdomain}.workers.dev` as `local.api_host`. The API application
  is `self_hosted`, with `name` and `domain` set to that host and a `public` destination whose `uri` is the host.
  Add `preview_worker` with `api_worker_id` on the second apply for every preview URL. This is the
  [provider v5.27 schema](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.27.0/docs/resources/zero_trust_access_application.md)
  fallback, not an inspected copy of the dashboard toggle's application: Cloudflare credentials were absent.
  `destinations` supersedes deprecated `self_hosted_domains`, so the latter is omitted. A `worker` destination
  requires the immutable Worker id and cannot be configured before the first deploy.
  `workers_dev` and `preview_urls` remain `true` in `apps/api-worker/wrangler.jsonc`. `/healthz` stays behind Access.
- **WebSocket probe.** G-04 WebSocket upgrade through worker-level Access: passed 2026-10-13 with a
  `cf-access-token` user token; Bearer / Managed OAuth and Service Token upgrade still open. The throwaway
  `hive-ws-probe.<subdomain>.workers.dev` Worker received `cf-access-jwt-assertion` on both HTTP and WebSocket
  requests and echoed the WebSocket. This refutes the blanket worker-level WebSocket 403 claim for this setup,
  not every destination/token combination. A `cloudflared` app token in `Authorization: Bearer` received a
  302; that token is not a Managed OAuth token. Combining `public` and `preview_worker` remains unverified (G-02).
- **Policies.** `hive executors` (`non_identity`, every executor Service Token) at precedence 1, before
  `hive api users` (`allow`, `allowed_emails`): under an allow policy a Service Token would still be sent to the
  login page. The Worker still requires the device token / Run capability behind it.
- **Managed OAuth.** Dynamic client registration for `localhost` / `127.0.0.1` redirects (`hive login`, Electron),
  access tokens of 15 min, grants of 14 days (`336h`); the browser session is 7 days (`168h`). Access session
  revocation is invisible to the Worker until the current assertion expires.
- **Routine hooks (ROUTINE-02).** `routine_hooks` is a more specific public destination,
  `hive-api.<subdomain>.workers.dev/v1/hooks/routines/*`, with a `bypass` policy for everyone. The Worker authenticates each POST
  with its per-routine HMAC signature, caps JSON at 64 KiB and limits accepted requests to 60/minute/routine.
  Never bypass `/v1/*` or the whole API hostname. Integration webhooks remain on their separate unprotected
  Worker; there is no `/v1/integrations/*` bypass to extend. Preview-worker destinations remain protected:
  use the production workers.dev URL for external Routine hooks.
  See [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
  and the [provider v5.27 schema](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.27.0/docs/resources/zero_trust_access_application.md).

## Apply

Needs Terraform and `CLOUDFLARE_API_TOKEN` with D1 edit, R2 edit, Access apps and policies edit and Access service
tokens edit on the account.

First-deploy order: the `preview_worker` destination needs the Worker's immutable id, which exists only after the
first deploy, and the deploy needs the D1 id from Terraform. Provider v5 has no data source that maps the script
name to the id (`cloudflare_worker` echoes the `worker_id` you pass).

1. Copy `infra/example.tfvars` to `infra/terraform.tfvars` and replace the account, team, subdomain and email
   placeholders. Keep `api_worker_id` empty; set `executor_devices` for the PCs that will run the executor.
2. Apply D1, R2, tokens and Access on the production workers.dev hostname before deploying:

   ```sh
   terraform -chdir=infra init
   terraform -chdir=infra plan
   terraform -chdir=infra apply
   terraform -chdir=infra output
   ```

3. Wire the outputs, apply migrations and deploy both Workers (below). Preview URLs are not protected yet;
   do not distribute or use them before the second apply.
4. Read the immutable id without exposing the API token:

   ```sh
   curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/workers/hive-api" |
     jq -r .result.id
   ```

   Set `api_worker_id` in `infra/terraform.tfvars` and run `terraform -chdir=infra apply` again:
   preview URLs are protected from then on.

5. Use the `api_url` output for `hive login` and client configuration, then register each executor PC
   with its Service Token as described below.

```sh
terraform -chdir=infra output -raw api_url
```

State uses the local backend (`infra/terraform.tfstate`, gitignored). To share it, add an `s3` backend block
pointing at an R2 bucket.

## Wire the outputs into the repo

1. Paste `d1_database_id` into `database_id` in `apps/api-worker/wrangler.jsonc` and
   `apps/integration-worker/wrangler.jsonc`.
2. Set `ACCESS_TEAM_DOMAIN` = `access_team_domain` and `ACCESS_AUD` = `access_aud` in the `vars` of
   `apps/api-worker/wrangler.jsonc`.
3. Keep `workers_dev: true` and `preview_urls: true`; no custom-domain route is needed.
4. Apply migrations and deploy from the repository root:

   ```sh
   bun run --cwd apps/api-worker wrangler d1 migrations apply hive --remote
   bun run --cwd apps/api-worker wrangler deploy
   bun run --cwd apps/integration-worker wrangler secret put GITHUB_WEBHOOK_SECRET
   bun run --cwd apps/integration-worker wrangler secret put SLACK_SIGNING_SECRET
   bun run --cwd apps/integration-worker wrangler deploy
   ```

5. Complete the second Terraform apply (above). For each executor PC (`executor_devices`; adding one means
   editing the list and applying again), store its Service Token on that PC after login against `api_url`.
   The secret is returned only when the token is created: Terraform keeps it in the state,
   the dashboard never shows it again.

   ```sh
   terraform -chdir=infra output -json executor_service_tokens   # client ids per device
   # The secret goes through stdin, never onto the screen or into a file:
   terraform -chdir=infra output -json executor_service_token_secrets | jq -r .laptop |
     hive device register --name laptop --os darwin --agent-version 0 \
       --access-client-id <client id> --access-client-secret-file -
   ```

## Android App Links and FCM (MOBILE-01)

Build `apps/mobile` with `HIVE_API_URL=https://hive-api.<subdomain>.workers.dev` (the `api_url` output) to configure
the Android HTTPS callback intent filter. Allow the exact `https://hive-api.<subdomain>.workers.dev/mobile/callback`
redirect for Managed OAuth DCR; loopback-only redirect permissions do not cover Android. This tenant configuration
and real-device PKCE/refresh remain G-03, not executed.

Set Worker vars `MOBILE_APP_PACKAGE=com.hive.mobile` and `MOBILE_APP_SHA256` (colon-delimited SHA-256 certificate
fingerprints, comma-separated for multiple release/debug certificates). `GET /.well-known/assetlinks.json` publishes
the Android association; `GET /mobile/callback` is a no-store page with an explicit HTTPS Android intent handoff.
Android's association fetch is unauthenticated: configure a path-specific Access application/bypass for
`/.well-known/assetlinks.json` (and the callback page if needed), without bypassing any `/v1/*` API route.
The current Terraform workers.dev application does not configure these path exceptions automatically.
`MOBILE_DEV_SCHEME=true` enables a custom `hive://callback` handoff only on a dev Worker; the matching mobile build
flag is `HIVE_MOBILE_DEV_SCHEME=1`. Do not enable these in production.

For FCM, enable the Firebase Cloud Messaging HTTP v1 API, provision a service account allowed to send messages in
the Firebase project, and put its JSON in a Worker secret without printing it:

```sh
bun run --cwd apps/api-worker wrangler secret put FCM_SERVICE_ACCOUNT_JSON < /path/to/service-account.json
```

Before mobile prebuild, set `HIVE_GOOGLE_SERVICES_FILE` to the Firebase Android configuration for `com.hive.mobile`;
never commit credential files. The Worker exchanges a signed service-account assertion for an OAuth token and sends
directly to FCM HTTP v1, not through the Expo push gateway. If the secret is absent, push is disabled and HTTP/sync/
approvals still work.

Apply migration `0034_mobile_push_tokens.sql` before deploying. `POST /v1/devices/mobile` registers `{instanceId, token}`
for the authenticated user; DELETE unregisters their instance. A native token has only one owner and changes account
atomically on re-registration. Approval requests and authorized user mentions/DM replies carry only `{kind, id}` in
FCM data plus generic visible notification text; there are no excerpts or approval credentials. Target lookups and
approval answers are authorized against current state. Real FCM delivery requires Firebase credentials and has not
been verified by the local emulator check.

DM-thread routing, executor claim/context checks and push recipient lookup resolve the parent DM; Channel threads
retain the parent's non-viewer membership requirement (PERM-01).
