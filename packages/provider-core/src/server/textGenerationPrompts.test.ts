import { describe, expect, it } from "vite-plus/test";

import { TextGenerationError } from "@t3tools/contracts";

import { isTextGenerationRateLimitError, normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

it.each([
  ["Rate limit reached", undefined, true],
  ["You've hit your limit · resets later", undefined, true],
  ["You've hit your session limit · resets later", undefined, true],
  ["You've hit your weekly limit · resets later", undefined, true],
  [
    'Claude CLI command failed: {"type":"result","is_error":true,"api_error_status":429,"result":"Request rejected"}',
    undefined,
    true,
  ],
  [
    'Claude CLI command failed: [{"type":"assistant","message":"Synthetic output"},{"type":"result","is_error":true,"api_error_status":429}]',
    undefined,
    true,
  ],
  [
    'Claude CLI command failed: {"type":"result","is_error":true,"result":"You\'ve hit your session limit"}',
    undefined,
    true,
  ],
  [
    'Claude CLI command failed: {"type":"result","is_error":true,"api_error_status":500,"result":"Internal error","prompt":"Rate limit reached"}',
    undefined,
    false,
  ],
  [
    'Claude CLI command failed: {"type":"result","is_error":false,"result":"You\'ve hit your session limit","api_error_status":429}',
    undefined,
    false,
  ],
  [
    "Codex CLI command failed: echoed prompt: rate limit reached\nERROR: Invalid model",
    undefined,
    false,
  ],
  ["Request failed", { status: 429 }, true],
  ["SDK failed", new Error("Request failed", { cause: { statusCode: 429 } }), true],
  ["Request failed", { code: "usageLimitExceeded" }, true],
  ["Request failed", { data: { statusCode: 429 } }, true],
  ["Request failed", { cause: { errorMessage: "Rate limited" } }, true],
  ["Request timed out", undefined, false],
  ["Sign in to continue", undefined, false],
  ["Request failed", { statusCode: 500 }, false],
  ["Invalid output", { _tag: "SchemaError", message: "Invalid title: rate limit reached" }, false],
] as const)("detects rate limits in %s", (detail, cause, expected) => {
  expect(
    isTextGenerationRateLimitError(
      new TextGenerationError({ operation: "synthetic", detail, cause }),
    ),
  ).toBe(expected);
});
