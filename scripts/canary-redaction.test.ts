import { expect, it } from "vite-plus/test";
import { redactCanary } from "./canary-redaction.ts";

it("redacts every outcome string, including split and JSON-escaped secrets", () => {
  const secret = "synthetic-canary-secret-123456";
  const outcome = {
    provider: secret,
    detail: `rewind: ${secret} again ${secret}`,
    nested: [
      secret.slice(0, 12) + "\n" + secret.slice(12),
      JSON.stringify({ error: secret }),
      secret.slice(0, 12) + "\\n" + secret.slice(12),
      "\\u0073" + secret.slice(1),
    ],
  };
  const clean = redactCanary(outcome, [secret]);
  expect(clean).toEqual({
    provider: "[redacted]",
    detail: "rewind: [redacted] again [redacted]",
    nested: ["[redacted]", '{"error":"[redacted]"}', "[redacted]", "[redacted]"],
  });
});
it.each([
  "sk-syntheticKey1234567890",
  "ghp_syntheticToken1234567890",
  "Bearer synthetic-token-123",
  'api_key="' + "a".repeat(64) + '"',
  "token: " + "Ab9/".repeat(20),
])("redacts common token patterns without secret values: %s", (token) => {
  expect(JSON.stringify(redactCanary({ detail: `failed ${token}` }))).not.toContain(token);
  expect(redactCanary({ detail: `failed ${token}` })).toEqual({
    detail: expect.stringContaining("[redacted]"),
  });
});
it("redacts long tokens in JSON fields and JSON-escaped error text", () => {
  const token = "abCD1234".repeat(8);
  expect(
    redactCanary({ api_key: token, detail: JSON.stringify({ token }).replaceAll('"', '\\"') }),
  ).toEqual({ api_key: "[redacted]", detail: '{\\"token\\":\\"[redacted]\\"}' });
});
