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

resource "cloudflare_zero_trust_access_application" "api" {
  account_id = var.account_id
  name       = "hive api"
  type       = "self_hosted"
  domain     = var.api_hostname
  policies   = [{ id = cloudflare_zero_trust_access_policy.api_users.id, precedence = 1 }]
}

# Paths that carry their own token auth (device token, Run capability) or none (/healthz) skip Access.
# A path also covers everything below it, and the more specific application wins over `api`.
# Upgrade (docs/architecture.md §18.1): a separate executor host with per-device Service Auth.
resource "cloudflare_zero_trust_access_policy" "token_paths" {
  account_id = var.account_id
  name       = "hive token paths"
  decision   = "bypass"
  include    = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_application" "token_paths" {
  account_id = var.account_id
  name       = "hive api token paths"
  type       = "self_hosted"
  destinations = [for path in ["/healthz", "/v1/executor", "/v1/run"] :
  { type = "public", uri = "${var.api_hostname}${path}" }]
  policies = [{ id = cloudflare_zero_trust_access_policy.token_paths.id, precedence = 1 }]
}
