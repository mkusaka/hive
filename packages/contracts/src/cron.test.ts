import { describe, expect, it } from "vitest";
import { isTimeZone, nextCron, parseCron } from "./cron.ts";

const next = (expr: string, timeZone: string, after: string) => {
  const at = nextCron(parseCron(expr), timeZone, Date.parse(after));
  return at === null ? null : new Date(at).toISOString();
};

describe("cron", () => {
  it("computes the next weekday 09:00 in Asia/Tokyo", () => {
    // Friday 10:00 JST → Monday 09:00 JST.
    expect(next("0 9 * * 1-5", "Asia/Tokyo", "2026-10-09T01:00:00Z")).toBe(
      "2026-10-12T00:00:00.000Z",
    );
    expect(next("0 9 * * 1-5", "Asia/Tokyo", "2026-10-11T23:59:59Z")).toBe(
      "2026-10-12T00:00:00.000Z",
    );
  });

  it("supports lists, ranges and steps in every field and is strictly after", () => {
    expect([...parseCron("5,10-14/2 */6 1-3 */4 0").minute]).toEqual([5, 10, 12, 14]);
    expect([...parseCron("0 */6 * * *").hour]).toEqual([0, 6, 12, 18]);
    expect([...parseCron("0 0 * 2/5 *").month]).toEqual([2, 7, 12]);
    expect(next("*/15 * * * *", "UTC", "2026-10-11T10:07:30Z")).toBe("2026-10-11T10:15:00.000Z");
    expect(next("*/15 * * * *", "UTC", "2026-10-11T10:15:00Z")).toBe("2026-10-11T10:30:00.000Z");
    expect(next("0 0 1 */3 *", "UTC", "2026-10-11T00:00:00Z")).toBe("2027-01-01T00:00:00.000Z");
  });

  it("matches either day field when both are restricted; 7 is Sunday", () => {
    // 2026-10-13 is a Tuesday (the 13th); 2026-10-16 is a Friday.
    expect(next("0 0 13 * 5", "UTC", "2026-10-12T00:00:00Z")).toBe("2026-10-13T00:00:00.000Z");
    expect(next("0 0 13 * 5", "UTC", "2026-10-13T00:00:00Z")).toBe("2026-10-16T00:00:00.000Z");
    expect(next("0 0 * * 7", "UTC", "2026-10-12T00:00:00Z")).toBe("2026-10-18T00:00:00.000Z");
  });

  it("skips a local time in the DST gap", () => {
    // America/New_York springs forward at 02:00 on 2026-03-08: 02:30 does not exist that day.
    expect(next("30 2 * * *", "America/New_York", "2026-03-07T12:00:00Z")).toBe(
      "2026-03-09T06:30:00.000Z",
    );
  });

  it("fires a repeated local time once, at its first instant", () => {
    // Falls back at 02:00 EDT on 2026-11-01: 01:30 happens at 05:30Z (EDT) and 06:30Z (EST).
    const first = next("30 1 * * *", "America/New_York", "2026-10-31T12:00:00Z");
    expect(first).toBe("2026-11-01T05:30:00.000Z");
    expect(next("30 1 * * *", "America/New_York", first!)).toBe("2026-11-02T06:30:00.000Z");
    // Every 30 minutes: the repeated hour is not fired again.
    expect(next("*/30 * * * *", "America/New_York", "2026-11-01T05:30:00Z")).toBe(
      "2026-11-01T07:00:00.000Z",
    );
  });

  it("rejects invalid expressions and zones; an impossible date never fires", () => {
    for (const expr of [
      "60 * * * *",
      "* * * *",
      "a * * * *",
      "5-1 * * * *",
      "*/0 * * * *",
      "0 0 0 * *",
    ]) {
      expect(() => parseCron(expr)).toThrow();
    }
    expect(isTimeZone("Asia/Tokyo")).toBe(true);
    expect(isTimeZone("Mars/Base")).toBe(false);
    expect(next("0 0 31 2 *", "UTC", "2026-01-01T00:00:00Z")).toBeNull();
  });
});
