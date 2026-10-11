import { afterEach, expect, it, vi } from "vitest";
import { fakeAdapter } from "../src/adapters/fake.ts";
import { type AgentAdapter, runLoop } from "../src/runner.ts";
import { fakeCloud, memoryJournal } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

it("on SIGTERM stops the running agent, leaves its Run for reconcile, stops polling and exits", async () => {
  const listeners = process.listenerCount("SIGTERM");
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const { cloud, submitted } = fakeCloud();
  const journal = memoryJournal();
  const stops: string[] = [];
  const inner = fakeAdapter({ delayMs: 5_000 });
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const adapter: AgentAdapter = {
    start: async (ctx) => {
      const agent = await inner.start(ctx);
      started();
      return {
        ...agent,
        requestStop: async (reason) => {
          stops.push(reason);
          await agent.requestStop(reason);
        },
      };
    },
  };

  const loop = runLoop({ cloud, journal, adapter }, { once: false, pollMs: 10 });
  await running;
  await new Promise((resolve) => setTimeout(resolve, 0)); // the runner registers the agent after start resolves
  const at = Date.now();
  process.emit("SIGTERM");
  await loop;

  expect(Date.now() - at).toBeLessThan(1_000);
  expect(stops).toEqual(["sigterm"]);
  expect(submitted).toEqual([]);
  expect(journal.entries.map((e) => e.kind)).toEqual(["claim", "intent"]);
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  expect(process.listenerCount("SIGTERM")).toBe(listeners);
});
