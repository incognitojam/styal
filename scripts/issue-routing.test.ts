import { describe, expect, it } from "vite-plus/test";
import { classifyReport, discordPayload, issueLabels } from "./issue-routing.ts";

describe("issue routing", () => {
  it.each([
    ["<!-- styal-report: kind=agent version=0.1.1-nightly.20261112.1367 -->", "agent"],
    ["Report\n<!-- styal-report: kind=user version=0.1.1 -->", "user"],
    ["Sent from styal by the user.", "user"],
    ["Report\nWritten by an agent and approved by the user.\n", "agent"],
    ["Report\nWritten by an agent (Codex, model) and approved by the user.", "agent"],
    ["Report\nWritten by an agent (model) and approved by the user.", "agent"],
    ["Sent from styal by the user.\nMore text", "other"],
    ["Written by an agent (Codex, model) and approved by the user.\nMore text", "other"],
    ["> Sent from styal by the user.", "other"],
    ["", "other"],
    [null, "other"],
    [undefined, "other"],
    ["Example\n<!-- styal-report: kind=agent version=0.1.1 -->\nMore text", "agent"],
    ["> <!-- styal-report: kind=agent version=0.1.1 -->", "other"],
    ["<!-- styal-report: kind=admin version=0.1.1 -->", "other"],
    [
      "<!-- styal-report: kind=user version=0.1.1 -->\nWritten by an agent and approved by the user.",
      "user",
    ],
    ["Report\r\nSent from styal by the user.\r\n", "user"],
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
  });
});
