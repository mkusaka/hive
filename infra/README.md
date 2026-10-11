# infra

Terraform for the owner's Cloudflare resources: D1 database `hive`, R2 bucket `hive`, one Access Service Token per
executor PC, one Access application protecting the API Worker, and a path-specific bypass application for signed
Routine webhooks. Workers, bindings and the Worker custom domain stay with Wrangler (docs/architecture.md §1).
The integration worker stays outside Access.

## Access application

- **Destinations.** The custom domain `api_hostname` as a hostname destination, plus `preview_worker` with
  `api_worker_id` for every preview URL. Not a single `worker` destination: Cloudflare documents that worker-level
  Access answers WebSocket upgrades with 403, which would break `/v1/realtime`
  (https://developers.cloudflare.com/workers/configuration/cloudflare-access/). `workers_dev` is `false` in
  `apps/api-worker/wrangler.jsonc`, so production has no unprotected `workers.dev` host. `/healthz` remains behind
  Access; the only custom-domain bypass is `/v1/hooks/routines/*` (below). Unconfirmed until G-02: whether Access
  accepts a `public` and a `preview_worker` destination in one application; the fallback is two applications
  attaching the same policies.
- **Policies.** `hive executors` (`non_identity`, every executor Service Token) at precedence 1, before
  `hive api users` (`allow`, `allowed_emails`): under an allow policy a Service Token would still be sent to the
  login page. The Worker still requires the device token / Run capability behind it.
- **Managed OAuth.** Dynamic client registration for `localhost` / `127.0.0.1` redirects (`hive login`, Electron),
  access tokens of 15 min, grants of 14 days (`336h`); the browser session is 7 days (`168h`). Access session
  revocation is invisible to the Worker until the current assertion expires.
- **Routine hooks (ROUTINE-02).** `routine_hooks` is a more specific public destination,
  `${api_hostname}/v1/hooks/routines/*`, with a `bypass` policy for everyone. The Worker authenticates each POST
  with its per-routine HMAC signature, caps JSON at 64 KiB and limits accepted requests to 60/minute/routine.
  Never bypass `/v1/*` or the whole API hostname. Integration webhooks remain on their separate unprotected
  Worker; there is no `/v1/integrations/*` bypass to extend. Preview-worker destinations remain protected:
  use the custom-domain URL for external Routine hooks.
  See [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
  and the [provider v5.27 schema](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.27.0/docs/resources/zero_trust_access_application.md).

## Apply

Needs Terraform and `CLOUDFLARE_API_TOKEN` with D1 edit, R2 edit, Access apps and policies edit and Access service
tokens edit on the account.

First-deploy order: the `preview_worker` destination needs the Worker's immutable id, which exists only after the
first deploy, and the deploy needs the D1 id from Terraform. Provider v5 has no data source that maps the script
name to the id (`cloudflare_worker` echoes the `worker_id` you pass).

1. `terraform apply` with `api_worker_id` empty: D1, R2, tokens and the application on the custom domain only.
2. Wire the outputs and deploy (below).
3. Read the id with `curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
https://api.cloudflare.com/client/v4/accounts/<account_id>/workers/workers/hive-api | jq -r .result.id`, set
   `api_worker_id` in `terraform.tfvars` and `terraform apply` again: preview URLs are protected from then on.

```sh
cd infra
cp example.tfvars terraform.tfvars   # account_id, access_team_name, api_hostname, allowed_emails,
                                     # api_worker_id, executor_devices
terraform init
terraform plan
terraform apply
terraform output
```

State uses the local backend (`infra/terraform.tfstate`, gitignored). To share it, add an `s3` backend block
pointing at an R2 bucket.

## Wire the outputs into the repo

1. Paste `d1_database_id` into `database_id` in `apps/api-worker/wrangler.jsonc` and
   `apps/integration-worker/wrangler.jsonc`.
2. Set `ACCESS_TEAM_DOMAIN` = `access_team_domain` and `ACCESS_AUD` = `access_aud` in the `vars` of
   `apps/api-worker/wrangler.jsonc`.
3. Add the custom domain to `apps/api-worker/wrangler.jsonc`:
   `"routes": [{ "pattern": "<api_hostname>", "custom_domain": true }]`.
4. For each executor PC (`executor_devices`; adding one means editing the list and applying again), store its
   Service Token on that PC. The secret is returned only when the token is created: Terraform keeps it in the state,
   the dashboard never shows it again.

   ```sh
   terraform output -json executor_service_tokens   # client ids per device
   # The secret goes through stdin, never onto the screen or into a file:
   terraform output -json executor_service_token_secrets | jq -r .laptop |
     hive device register --name laptop --os darwin --agent-version 0 \
       --access-client-id <client id> --access-client-secret-file -
   ```

5. Apply migrations and deploy:

   ```sh
   cd apps/api-worker
   bunx wrangler d1 migrations apply hive --remote
   bunx wrangler deploy
   cd ../integration-worker
   bunx wrangler secret put GITHUB_WEBHOOK_SECRET
   bunx wrangler secret put SLACK_SIGNING_SECRET
   bunx wrangler deploy
   ```
