import { expect, it } from "vite-plus/test";
import { ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import { discardsClaudeModelCache } from "./claudeSessionResume";
it("warns only when a live Claude cache is lost in a resumed history", () => {
  const claude = ProviderInstanceId.make("claudeAgent");
  const other = ProviderInstanceId.make("other");
  const input = {
    current: { instanceId: claude, model: "claude-opus-5-5" },
    next: { instanceId: claude, model: "claude-sonnet-5-5" },
    providers: [
      {
        instanceId: claude,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        continuationGroupKey: "shared",
      },
      {
        instanceId: other,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        continuationGroupKey: "separate",
      },
    ],
    usedTokens: 250000,
    updatedAt: "2026-06-01T12:00:00Z",
    now: Date.parse("2026-06-01T12:05:00Z"),
  };
  expect(discardsClaudeModelCache(input)).toBe(true);
  expect(
    discardsClaudeModelCache({
      ...input,
      updatedAt: "2026-06-01T12:04:40Z",
      now: Date.parse("2026-06-01T12:04:41Z"),
    }),
  ).toBe(true);
  expect(discardsClaudeModelCache({ ...input, now: Date.parse("2026-06-01T13:00:00Z") })).toBe(
    false,
  );
  expect(discardsClaudeModelCache({ ...input, next: input.current })).toBe(false);
  expect(discardsClaudeModelCache({ ...input, next: { ...input.next, instanceId: other } })).toBe(
    false,
  );
  expect(discardsClaudeModelCache({ ...input, ttl: 300000 })).toBe(false);
  expect(discardsClaudeModelCache({ ...input, updatedAt: undefined })).toBe(false);
  expect(discardsClaudeModelCache({ ...input, usedTokens: 100 })).toBe(false);
});
