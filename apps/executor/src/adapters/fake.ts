// Fake provider (docs/roadmap.md §4 process integration): exits after `delayMs`; idempotent, so a resumed
// Run can simply start it again. Never counts as real-provider acceptance.
import type { AgentAdapter } from "../runner.ts";

export const fakeAdapter = ({ delayMs = 50, fail = false } = {}): AgentAdapter => ({
  start: async (ctx) => {
    let stop!: (reason: string) => void;
    const exited = new Promise<{ code: number | null; reason: string; summary: string }>(
      (resolve) => {
        const summary = `fake: handled inbox item ${ctx.inboxItemId}`;
        const timer = setTimeout(
          () =>
            resolve(
              fail
                ? { code: 1, reason: "FAKE_FAIL", summary }
                : { code: 0, reason: "exited", summary },
            ),
          delayMs,
        );
        stop = (reason) => {
          clearTimeout(timer);
          resolve({ code: null, reason, summary: "fake: stopped" });
        };
      },
    );
    return { requestStop: async (reason) => stop(reason), waitForExit: () => exited };
  },
});
