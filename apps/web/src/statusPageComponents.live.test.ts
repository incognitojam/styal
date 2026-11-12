import { describe, expect, it } from "vite-plus/test";

import { CLAUDE_RELEVANT_COMPONENTS, CLAUDE_STATUS_PAGE_URL } from "./claudeStatus";
import { GITHUB_RELEVANT_COMPONENTS, GITHUB_STATUS_PAGE_URL } from "./githubStatus";
import { OPENAI_RELEVANT_COMPONENTS, OPENAI_STATUS_PAGE_URL } from "./openaiStatus";
import { missingStatusPageComponents } from "./statusPage";

// Reads the real status pages, so it runs only in the scheduled status page check workflow.
describe.runIf(process.env.STYAL_STATUS_PAGE_LIVE_CHECK === "1")("live status pages", () => {
  it.each([
    ["Claude", CLAUDE_STATUS_PAGE_URL, CLAUDE_RELEVANT_COMPONENTS],
    ["GitHub", GITHUB_STATUS_PAGE_URL, GITHUB_RELEVANT_COMPONENTS],
    ["OpenAI", OPENAI_STATUS_PAGE_URL, OPENAI_RELEVANT_COMPONENTS],
  ])("%s still lists every component its outage filter names", async (_service, page, names) => {
    const url = `${page}/api/v2/components.json`;
    const response = await fetch(url);
    expect(response.ok, `${url} returned HTTP ${response.status}`).toBe(true);
    const missing = missingStatusPageComponents(await response.json(), names);
    expect(missing, `${url} returned no component listing`).not.toBeNull();
    expect(missing).toEqual([]);
  });
});
