import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  inheritedProviderEnvironment,
  mergeProviderInstanceEnvironment,
} from "./ProviderInstanceEnvironment.ts";

describe("inheritedProviderEnvironment", () => {
  it("leaves the server's own settings behind", () => {
    expect(
      inheritedProviderEnvironment({
        PATH: "/bin",
        ANTHROPIC_API_KEY: "sk-ant-test",
        STYAL_HOME: "/home/example/.styal",
        T3CODE_PORT: "3773",
        T3CODE_HOST: "0.0.0.0",
        T3CODE_TAILSCALE_SERVE: "true",
        T3_SERVICE_LAUNCHER_CONTEXT: '{"childVersion":"9.9.9"}',
        T3_BOOT_SERVICE_UNIT: "styal.service",
        VITE_DEV_SERVER_URL: "http://localhost:5173",
        PORT: "5173",
        ELECTRON_RUN_AS_NODE: "1",
      }),
    ).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-test" });
  });

  it("keeps the Codex launch args override the Codex adapter reads back", () => {
    expect(
      inheritedProviderEnvironment({
        T3CODE_CODEX_LAUNCH_ARGS: "--strict-config",
        T3CODE_PORT: "3773",
      }),
    ).toEqual({ T3CODE_CODEX_LAUNCH_ARGS: "--strict-config" });
  });
});

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join(NodeOS.homedir(), tail),
        CLAUDE_CONFIG_DIR: path.join(NodeOS.homedir(), tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("leaves inherited provider homes unchanged", () => {
    const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
        baseEnv,
      ),
    ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
  });

  it("keeps server-prefixed variables that the caller or instance supplies", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "T3CODE_HOST", value: "configured", sensitive: false }],
        { T3CODE_WORKSPACE_PORT: "24120" },
      ),
    ).toEqual({ T3CODE_HOST: "configured", T3CODE_WORKSPACE_PORT: "24120" });
  });

  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });
});
