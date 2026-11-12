import { describe, expect, it, vi } from "vite-plus/test";
import { classifyReport, discordPayload, issueLabels, postDiscord } from "./issue-routing.ts";

describe("issue routing", () => {
  const footer = "\n\n---\nstyal 0.1.1-nightly.20261112.1367 (nightly), linux x64\n";
  it.each([
    [`Report${footer}Sent from styal by the user.`, "user"],
    [`Report${footer}Written by an agent and approved by the user.`, "agent"],
    [`Report${footer}Written by an agent (Codex, model) and approved by the user.`, "agent"],
    [`Report${footer}Written by an agent (model) and approved by the user.`, "agent"],
    [`Report${footer}Sent from styal by the user.\nMore text`, "other"],
    [
      `Report${footer}Written by an agent (Codex, model) and approved by the user.\nMore text`,
      "other",
    ],
    ["Sent from styal by the user.", "other"],
    ["Written by an agent and approved by the user.", "other"],
    [`Report${footer}> Sent from styal by the user.`, "other"],
    ["Example\n> ---\n> styal 0.1.1 (nightly), linux x64\n> Sent from styal by the user.", "other"],
    [`Report${footer}Unknown author.`, "other"],
    ["Report\n\n---\nstyal 0.1.1\nSent from styal by the user.", "other"],
    [
      "Report\n\n---\nstyal 0.1.1 (nightly), linux x64 extra\nSent from styal by the user.",
      "other",
    ],
    [`Report${footer}Sent from styal by the user.\n  \t`, "user"],
    [`Report${footer}Sent from styal by the user.`.replaceAll("\n", "\r\n"), "user"],
    ["", "other"],
    [null, "other"],
    [undefined, "other"],
  ] as const)("classifies %s as %s", (body, expected) => {
    expect(classifyReport(body)).toBe(expected);
    expect(issueLabels(classifyReport(body))).toEqual(
      expected === "other"
        ? ["needs-triage"]
        : ["needs-triage", "from-styal", `${expected}-report`],
    );
  });

  it("serializes hostile titles as data without enabling mentions or including the body", () => {
    const issue = {
      number: 42,
      title: '`$(touch nope)` "\n@everyone <@123>',
      html_url: "https://github.com/example/project/issues/42",
      user: { login: "octocat" },
      body: "private report text",
    };
    const payload = JSON.parse(JSON.stringify(discordPayload(issue, "agent")));
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0].title).toBe(`#42: ${issue.title}`);
    expect(payload.embeds[0].url).toBe(issue.html_url);
    expect(payload.embeds[0].fields).toEqual([
      { name: "Kind", value: "styal agent report" },
      { name: "Author", value: "octocat" },
    ]);
    expect(JSON.stringify(payload)).not.toContain(issue.body);
    expect(
      discordPayload({ ...issue, title: "x".repeat(400) }, "other").embeds[0]?.title,
    ).toHaveLength(256);
    const unicodeTitle = discordPayload({ ...issue, title: "x".repeat(250) + "😀" }, "user")
      .embeds[0]?.title;
    expect(unicodeTitle).toBe("#42: " + "x".repeat(250) + "😀");
    expect(Array.from(unicodeTitle ?? "")).toHaveLength(256);
  });
});

describe("Discord rate limits", () => {
  const issue = {
    number: 42,
    title: "A report",
    html_url: "https://github.com/example/project/issues/42",
    user: { login: "octocat" },
  };

  it("honors retry_after before delivering the same safe payload", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ retry_after: 0.25 }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ retry_after: 0.5 }, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const wait = vi.fn(async () => undefined);
    const payload = discordPayload(issue, "agent");
    expect(await postDiscord("https://example.invalid/webhook", payload, request, wait)).toBe(true);
    expect(wait.mock.calls).toEqual([[250], [500]]);
    expect(request).toHaveBeenCalledTimes(3);
    for (const [url, options] of request.mock.calls) {
      expect(url).toBe("https://example.invalid/webhook");
      expect(options?.body).toBe(JSON.stringify(payload));
    }
  });

  it.each([0.25, 31, -1, "1", null])(
    "gives up successfully on persistent or unusable rate limit %s",
    async (retryAfter) => {
      const request = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json({ retry_after: retryAfter }, { status: 429 }),
        );
      const wait = vi.fn(async () => undefined);
      expect(
        await postDiscord(
          "https://example.invalid/webhook",
          discordPayload(issue, "user"),
          request,
          wait,
        ),
      ).toBe(false);
      expect(request).toHaveBeenCalledTimes(retryAfter === 0.25 ? 3 : 1);
      expect(wait.mock.calls).toEqual(retryAfter === 0.25 ? [[250], [250]] : []);
    },
  );
});
