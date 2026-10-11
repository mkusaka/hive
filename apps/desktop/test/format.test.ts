import { describe, expect, it } from "vitest";
import {
  avatarColor,
  parseInline,
  parseMarkdown,
  scheduleLine,
} from "../src/renderer/src/format.ts";

const p = (text: string) => ({ kind: "p", inlines: [{ kind: "text", text }] });

describe("parseMarkdown", () => {
  it("splits paragraphs on blank lines and keeps line breaks inside one", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([p("one\ntwo"), p("three")]);
  });

  it("parses - and * bullets into one list", () => {
    expect(parseMarkdown("- a\n* b")).toEqual([
      { kind: "ul", items: [[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }]] },
    ]);
  });

  it("parses numbered lists and a paragraph after them", () => {
    expect(parseMarkdown("1. a\n2) b\nafter")).toEqual([
      { kind: "ol", items: [[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }]] },
      p("after"),
    ]);
  });

  it("ends a paragraph where a list starts", () => {
    expect(parseMarkdown("intro\n- x")).toEqual([
      p("intro"),
      { kind: "ul", items: [[{ kind: "text", text: "x" }]] },
    ]);
  });

  it("keeps a fenced code block verbatim, markup included", () => {
    expect(parseMarkdown("```ts\n**not bold**\n- not a list\n```\nafter")).toEqual([
      { kind: "code", text: "**not bold**\n- not a list" },
      p("after"),
    ]);
  });

  it("runs an unclosed fence to the end", () => {
    expect(parseMarkdown("```\nx")).toEqual([{ kind: "code", text: "x" }]);
  });

  it("treats HTML as text (nothing is ever rendered as markup)", () => {
    expect(parseMarkdown("<img src=x onerror=alert(1)>")).toEqual([
      p("<img src=x onerror=alert(1)>"),
    ]);
  });

  it("returns nothing for blank input", () => {
    expect(parseMarkdown("\n  \n")).toEqual([]);
  });
});

describe("parseInline", () => {
  it("parses bold, code and links between text", () => {
    expect(parseInline("a **b** `c` [d](https://e.test/f) g")).toEqual([
      { kind: "text", text: "a " },
      { kind: "bold", text: "b" },
      { kind: "text", text: " " },
      { kind: "code", text: "c" },
      { kind: "text", text: " " },
      { kind: "link", text: "d", url: "https://e.test/f" },
      { kind: "text", text: " g" },
    ]);
  });

  it("parses mention tokens", () => {
    expect(parseInline("<@bot:b-1> hi <@bot:b-2>")).toEqual([
      { kind: "mention", id: "b-1" },
      { kind: "text", text: " hi " },
      { kind: "mention", id: "b-2" },
    ]);
  });

  it("leaves unmatched markers as text", () => {
    expect(parseInline("2 * 3 ** 4 `x")).toEqual([{ kind: "text", text: "2 * 3 ** 4 `x" }]);
  });
});

const cron = (expr: string) => scheduleLine({ kind: "cron", expr, timezone: "UTC" });

describe("scheduleLine", () => {
  it("reads the common cron shapes and falls back to the expression", () => {
    expect(cron("0 9 * * 1-5")).toBe("Weekdays at 9:00 AM");
    expect(cron("21 13 * * *")).toBe("Daily at 1:21 PM");
    expect(cron("*/20 * * * *")).toBe("Every 20 minutes");
    expect(cron("14 * * * *")).toBe("Every hour at :14");
    expect(cron("0 0 1 * *")).toBe("0 0 1 * *");
  });

  it("formats a once schedule in the given zone", () => {
    expect(scheduleLine({ kind: "once", at: "2026-10-10T09:47:00.000Z" }, "UTC")).toBe(
      "Once October 10 at 9:47 AM",
    );
  });
});

it("gives an id the same avatar color every time", () => {
  expect(avatarColor("bot-1")).toBe(avatarColor("bot-1"));
  expect(avatarColor("bot-1")).not.toBe(avatarColor("bot-2"));
});
