output "d1_database_id" {
  value = cloudflare_d1_database.hive.id
}

output "r2_bucket_name" {
  value = cloudflare_r2_bucket.hive.name
}

# ACCESS_AUD
output "access_aud" {
  value = cloudflare_zero_trust_access_application.api.aud
}

# ACCESS_TEAM_DOMAIN (no scheme)
output "access_team_domain" {
  value = "${var.access_team_name}.cloudflareaccess.com"
}

output "api_hostname" {
  value = var.api_hostname
}

# CF-Access-Client-Id per executor device.
output "executor_service_tokens" {
  value = { for name, token in cloudflare_zero_trust_access_service_token.executor : name => token.client_id }
}

# CF-Access-Client-Secret per executor device. Cloudflare returns it only at creation: read it once with
# `terraform output -json executor_service_token_secrets` (it stays in the state, never in the dashboard).
output "executor_service_token_secrets" {
  value     = { for name, token in cloudflare_zero_trust_access_service_token.executor : name => token.client_secret }
  sensitive = true
}
