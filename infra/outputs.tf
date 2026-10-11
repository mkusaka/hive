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
