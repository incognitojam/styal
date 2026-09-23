import { describe, expect, it } from "vite-plus/test";

import redirect from "./apexRedirect.ts";

describe("managed tunnel apex redirect", () => {
  it("sends visitors to the repository without forwarding the path", () => {
    const response = redirect.fetch(new Request("https://styal.link/old-path"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://github.com/incognitojam/styal");
  });

  it("preserves the query string like the product apex redirect", () => {
    const response = redirect.fetch(new Request("https://styal.link/old-path?source=link"));

    expect(response.headers.get("location")).toBe(
      "https://github.com/incognitojam/styal?source=link",
    );
  });
});
