import { describe, expect, it } from "vite-plus/test";

import {
  resolveOpenCodeConfigContent,
  resolveOpenCodeConfigContentWithSkillRoot,
} from "./opencodeRuntime.ts";

describe("resolveOpenCodeConfigContent", () => {
  it("prefers the caller environment over the inherited environment", () => {
    expect(
      resolveOpenCodeConfigContent(
        { OPENCODE_CONFIG_CONTENT: '{"source":"caller"}' },
        { OPENCODE_CONFIG_CONTENT: '{"source":"process"}' },
      ),
    ).toBe('{"source":"caller"}');
  });

  it("falls back to the inherited environment and then an empty config", () => {
    expect(
      resolveOpenCodeConfigContent(undefined, {
        OPENCODE_CONFIG_CONTENT: '{"source":"process"}',
      }),
    ).toBe('{"source":"process"}');
    expect(resolveOpenCodeConfigContent(undefined, {})).toBe("{}");
  });
});

describe("resolveOpenCodeConfigContentWithSkillRoot", () => {
  it("preserves config and appends the bundled skill root", () => {
    expect(
      JSON.parse(
        resolveOpenCodeConfigContentWithSkillRoot(
          {
            OPENCODE_CONFIG_CONTENT:
              '{"model":"openai/gpt-5","skills":{"paths":["/existing"],"urls":["https://example.test/skills"]}}',
          },
          "/opt/t3-skills",
          {},
        ),
      ),
    ).toEqual({
      model: "openai/gpt-5",
      skills: {
        paths: ["/existing", "/opt/t3-skills"],
        urls: ["https://example.test/skills"],
      },
    });
  });

  it("does not overwrite invalid user config", () => {
    expect(
      resolveOpenCodeConfigContentWithSkillRoot(
        { OPENCODE_CONFIG_CONTENT: "not-json" },
        "/opt/t3-skills",
        {},
      ),
    ).toBe("not-json");
  });
});
