terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.27"
    }
  }
}

# Reads CLOUDFLARE_API_TOKEN from the environment.
provider "cloudflare" {}

resource "cloudflare_d1_database" "hive" {
  account_id = var.account_id
  name       = "hive"
}

resource "cloudflare_r2_bucket" "hive" {
  account_id = var.account_id
  name       = "hive"
}

# v5: policies are account-level and reusable; the application attaches them by id.
resource "cloudflare_zero_trust_access_policy" "api_users" {
  account_id = var.account_id
  name       = "hive api users"
  decision   = "allow"
  include    = [for email in var.allowed_emails : { email = { email = email } }]
}

# One Service Token per PC that runs `hive executor run` (docs/architecture.md §18.1). The Worker still checks the
# device token behind it; adding a PC means adding it to executor_devices and applying.
resource "cloudflare_zero_trust_access_service_token" "executor" {
  for_each   = toset(var.executor_devices)
  account_id = var.account_id
  name       = "hive executor ${each.key}"
}

resource "cloudflare_zero_trust_access_policy" "executors" {
  count      = length(var.executor_devices) > 0 ? 1 : 0
  account_id = var.account_id
  name       = "hive executors"
  decision   = "non_identity"
  include = [for token in cloudflare_zero_trust_access_service_token.executor :
  { service_token = { token_id = token.id } }]
}

# One application for the API Worker: the custom domain is a hostname destination because worker destinations
# reject WebSocket upgrades (/v1/realtime), and preview_worker covers every preview URL. workers.dev is off in
# wrangler.jsonc. Humans use Managed OAuth (CLI / Electron PKCE on a loopback redirect), executors Service Auth.
# Worker-level Access answers WebSocket upgrades with 403 (developers.cloudflare.com/workers/configuration/cloudflare-access/).
# Unconfirmed until G-02: whether Access accepts a public and a preview_worker destination in one application.
# Fallback: two applications (hostname, preview_worker) attaching the same policies.
resource "cloudflare_zero_trust_access_application" "api" {
  account_id = var.account_id
  name       = "hive api"
  type       = "self_hosted"
  # Browser session. The provider takes ns/us/ms/s/m/h only.
  session_duration     = "168h"
  app_launcher_visible = false
  destinations = concat(
    [{ type = "public", uri = var.api_hostname }],
    var.api_worker_id == "" ? [] : [{ type = "preview_worker", worker_id = var.api_worker_id }],
  )
  # Service Auth first: under an allow policy a Service Token would still be sent to the IdP login.
  policies = [for i, id in concat(cloudflare_zero_trust_access_policy.executors[*].id, [cloudflare_zero_trust_access_policy.api_users.id]) :
  { id = id, precedence = i + 1 }]
  oauth_configuration = {
    enabled = true
    dynamic_client_registration = {
      enabled                = true
      allow_any_on_localhost = true
      allow_any_on_loopback  = true
    }
    # Access token 15 min, refresh grant 14 days: `hive login` again after that.
    grant = {
      access_token_lifetime = "15m"
      session_duration      = "336h"
    }
  }
}

# Routine webhook callers authenticate with X-Hive-Signature, not Access. A more specific hostname/path
# application takes precedence over the API hostname application; no other API path is bypassed.
resource "cloudflare_zero_trust_access_application" "routine_hooks" {
  account_id           = var.account_id
  name                 = "hive routine hooks"
  type                 = "self_hosted"
  app_launcher_visible = false
  destinations         = [{ type = "public", uri = "${var.api_hostname}/v1/hooks/routines/*" }]
  policies = [{
    name       = "Signed routine webhooks"
    decision   = "bypass"
    precedence = 1
    include    = [{ everyone = {} }]
  }]
}
