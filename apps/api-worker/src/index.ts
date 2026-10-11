import { type Bindings, createApp } from "./app.ts";
import { createPerformers } from "./effects.ts";
import { pump } from "./pump.ts";
import { notify } from "./realtime.ts";

export { Realtime } from "./realtime.ts";

const app = createApp();

export default {
  fetch: app.fetch,
  // Every minute (wrangler.jsonc `triggers`) until a Queue consumer replaces it.
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(
      pump(env.DB, {
        owner: "cron",
        limit: 100,
        notify: (n) => ctx.waitUntil(notify(env, n)),
        performers: createPerformers(env),
      }),
    );
  },
} satisfies ExportedHandler<Bindings>;
