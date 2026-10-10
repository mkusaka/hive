import { type Bindings, createApp } from "./app.ts";
import { pump } from "./pump.ts";

const app = createApp();

export default {
  fetch: app.fetch,
  // Every minute (wrangler.jsonc `triggers`) until a Queue consumer replaces it.
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(pump(env.DB, { owner: "cron", limit: 100 }));
  },
} satisfies ExportedHandler<Bindings>;
