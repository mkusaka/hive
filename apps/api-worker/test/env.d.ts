declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    REALTIME: DurableObjectNamespace<import("../src/realtime.ts").Realtime>;
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
