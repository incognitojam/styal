import { describe, expect, it } from "vite-plus/test";

import { shouldHandleAppLink } from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each([
    "styal://",
    "styal:///",
    "styal-dev://",
    "styal-dev:///",
    "styal-preview://",
    "styal-preview:///",
    "t3code://",
    "t3code:///",
    "t3code-dev://",
    "t3code-preview://",
  ])("ignores scheme-only URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(false);
  });

  it.each([
    "styal://threads/env-1/thread-1",
    "styal://pair?pairingUrl=x",
    "styal-dev://settings/usage?tab=limits",
    "styal-preview://settings/auth",
    "styal://oauth-native-callback?code=synthetic-code",
    "t3code://threads/env-1/thread-1",
    "t3code://pair?pairingUrl=x",
    "t3code-dev://settings/usage?tab=limits",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(true);
  });

  it.each([
    "styal-dev://expo-development-client/?url=x",
    "styal://expo-sharing/anything",
    "t3code://expo-development-client/?url=x",
    "t3code://expo-sharing/anything",
  ])("ignores lifecycle URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(false);
  });
});
