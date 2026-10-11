declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    GITHUB_WEBHOOK_SECRET: string;
    SLACK_SIGNING_SECRET: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
