variable "account_id" {
  type        = string
  description = "Cloudflare account id."
}

variable "access_team_name" {
  type        = string
  description = "Zero Trust team name: the <team> in <team>.cloudflareaccess.com."
}

variable "api_hostname" {
  type        = string
  description = "Hostname of the API Worker custom domain, e.g. api.hive.example.com."
}

variable "allowed_emails" {
  type        = list(string)
  description = "Emails allowed through Access to the API."
}
