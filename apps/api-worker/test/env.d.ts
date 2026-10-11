declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    R2: R2Bucket;
    REALTIME: DurableObjectNamespace<import("../src/realtime.ts").Realtime>;
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    COLLECT_MIGRATION: string;
    FCM_SERVICE_ACCOUNT_JSON?: string;
  }
}
