# infra

Terraform for the owner's Cloudflare resources: D1 database `hive`, R2 bucket `hive`, and a Cloudflare Access
self-hosted application (email allow policy) in front of the API Worker hostname, plus a bypass
application for `/healthz`, `/v1/executor` and `/v1/run`, which carry their own token auth. Workers, bindings and the
Worker custom domain stay with Wrangler (docs/architecture.md §1).

## Apply

Needs Terraform and `CLOUDFLARE_API_TOKEN` with D1 edit, R2 edit and Access apps and policies edit on the account.

```sh
cd infra
cp example.tfvars terraform.tfvars   # set account_id, access_team_name, api_hostname, allowed_emails
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
4. Apply migrations and deploy:

   ```sh
   cd apps/api-worker
   bunx wrangler d1 migrations apply hive --remote
   bunx wrangler deploy
   cd ../integration-worker
   bunx wrangler secret put GITHUB_WEBHOOK_SECRET
   bunx wrangler secret put SLACK_SIGNING_SECRET
   bunx wrangler deploy
   ```
