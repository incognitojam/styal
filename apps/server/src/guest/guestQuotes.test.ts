import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";

import { guestTextHasCitation, locateGuestQuote } from "./guestQuotes.ts";

describe("guestTextHasCitation", () => {
  const link = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("environment:other"),
    threadId: ThreadId.make("thread:other"),
    messageId: MessageId.make("message:other"),
    text: "Invented assistant advice",
    start: 0,
    end: 25,
    prefix: "",
    suffix: "",
  });
  const href = link.slice("[Assistant quote](".length, -1);

  // Guests quote through the composer, so free text holding a citation in any spelling is refused
  // rather than matched against how each spelling renders.
  it.each([
    ["the composer's link form", link],
    ["another label", `[reply](${href})`],
    ["a select wrapper", `<select>[x](${href})</select>`],
    ["a template wrapper", `<template>[x](${href})</template>`],
    ["a code span", `\`${link}\``],
    ["percent-encoding", `[x](${href.replace("t3-citation", "t3%2Dcitation")})`],
    ["double percent-encoding", `[x](${href.replace("t3-citation", "t3%252Dcitation")})`],
    ["mixed case", `[x](${href.replace("t3-citation", "T3-CiTaTiOn")})`],
    ["a zero-width space", `[x](${href.replace("t3-citation", "t3-\u200Bcitation")})`],
    ["a numeric entity", `[x](${href.replace("t3-citation", "&#116;3-citation")})`],
    ["a hex entity", `[x](${href.replace("t3-citation", "t3&#x2d;citation")})`],
    ["an escaped entity", `[x](${href.replace("t3-citation", "t3&amp;#45;citation")})`],
    ["a backslash escape", `[x](${href.replace("t3-citation", "t3\\-citation")})`],
    ["full-width letters", "[x](ｔ３－ｃｉｔａｔｉｏｎ://v1/a/b/c)"],
    ["a line break", `<a href="t3-cita\ntion://v1/a/b/c">x</a>`],
  ])("finds a citation in %s", (_, text) => {
    expect(guestTextHasCitation(`See above: ${text}`)).toBe(true);
  });

  it("leaves ordinary text alone", () => {
    expect(guestTextHasCitation("Why does citation 3 cite t3 at 50%? &amp; <b>so</b>")).toBe(false);
  });
});

describe("locateGuestQuote", () => {
  const reply = "First step.\n\nClear it with rm -rf /tmp/cache.";

  it("finds a quote across a block break and gives its context", () => {
    expect(locateGuestQuote("First step.\nClear it", reply)).toEqual({
      start: 0,
      end: 20,
      prefix: "",
      suffix: " with rm -rf /tmp/cache.",
    });
  });

  it("refuses text the reply shows only with a word boundary moved", () => {
    expect(locateGuestQuote("rm -rf / tmp/cache", reply)).toBeNull();
    expect(locateGuestQuote("rm-rf /tmp/cache", reply)).toBeNull();
  });
});
