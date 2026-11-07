import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { SecretProviderId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  inheritedProviderEnvironment,
  mergeProviderInstanceEnvironment,
} from "./instanceEnvironment.ts";

describe("inheritedProviderEnvironment", () => {
  it("removes server-owned variables", () => {
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

  it("keeps T3CODE_CODEX_LAUNCH_ARGS", () => {
    expect(
      inheritedProviderEnvironment({
        T3CODE_CODEX_LAUNCH_ARGS: "--strict-config",
        T3CODE_PORT: "3773",
      }),
    ).toEqual({ T3CODE_CODEX_LAUNCH_ARGS: "--strict-config" });
  });
});

describe("mergeProviderInstanceEnvironment", () => {
  it.effect("follows host changes made after the merge, without server-owned variables", () => {
    const host: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      T3CODE_PORT: "3773",
      ACCOUNT: "from-host",
    };
    return Effect.gen(function* () {
      const inherited = yield* mergeProviderInstanceEnvironment(undefined);
      const configured = yield* mergeProviderInstanceEnvironment([
        { name: "ACCOUNT", value: "from-instance", sensitive: false },
      ]);

      host.PATH = "/home/ada/.local/bin:/usr/bin";

      expect({ ...inherited }).toEqual({
        PATH: "/home/ada/.local/bin:/usr/bin",
        ACCOUNT: "from-host",
      });
      expect({ ...configured }).toEqual({
        PATH: "/home/ada/.local/bin:/usr/bin",
        ACCOUNT: "from-instance",
      });
    }).pipe(
      Effect.provideService(HostProcess.Environment, host),
      Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
      Effect.provide(NodeServices.layer),
    );
  });

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
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join("/home/ada", tail),
        CLAUDE_CONFIG_DIR: path.join("/home/ada", tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("leaves inherited provider homes unchanged", () =>
    Effect.gen(function* () {
      const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
          baseEnv,
        ),
      ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
    }),
  );

  it.effect("gives a Windows override one spelling in the default host environment", () =>
    Effect.gen(function* () {
      const environment = yield* mergeProviderInstanceEnvironment([
        { name: "path", value: "C:\\configured", sensitive: false },
      ]);

      expect({ ...environment }).toEqual({ PATH: "C:\\configured", SystemRoot: "C:\\Windows" });
      expect(environment.Path).toBeUndefined();
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, {
        Path: "C:\\inherited",
        SystemRoot: "C:\\Windows",
      }),
    ),
  );

  it.effect("removes server-owned variables from the default host environment", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment([
          { name: "CUSTOM_VALUE", value: "configured", sensitive: false },
        ]),
      ).toEqual({ PATH: "/bin", CUSTOM_VALUE: "configured" });
    }).pipe(
      Effect.provideService(HostProcess.Environment, {
        PATH: "/bin",
        T3CODE_PORT: "3773",
        STYAL_HOME: "/home/example/.styal",
      }),
    ),
  );

  it.effect("does not filter an explicit base or instance-configured variables", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "T3CODE_HOST", value: "configured", sensitive: false }],
          { T3CODE_WORKSPACE_PORT: "24120" },
        ),
      ).toEqual({ T3CODE_HOST: "configured", T3CODE_WORKSPACE_PORT: "24120" });
    }),
  );

  it.effect("overrides inherited environment values and preserves empty strings", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
            { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
            {
              name: "OPENAI_API_KEY",
              value: {
                provider: SecretProviderId.make("personal"),
                reference: "op://Private/OpenAI/credential",
              },
              sensitive: true,
            },
          ],
          { ANTHROPIC_API_KEY: "inherited", OPENAI_API_KEY: "inherited", PATH: "/bin" },
        ),
      ).toMatchObject({
        OPENROUTER_API_KEY: "sk-or-test",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "inherited",
        PATH: "/bin",
      });
    }),
  );

  it.effect("replaces every inherited spelling of a name on Windows, and only there", () =>
    Effect.gen(function* () {
      const merge = (platform: NodeJS.Platform) =>
        mergeProviderInstanceEnvironment(
          [{ name: "Https_Proxy", value: "http://gateway", sensitive: false }],
          { HTTPS_PROXY: "http://mine", PATH: "/bin" },
        ).pipe(Effect.provideService(HostProcess.Platform, platform));
      // A home variable in another spelling is still expanded.
      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "Codex_Home", value: "~/corp", sensitive: false }],
          {},
        ).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
        ),
      ).toEqual({ CODEX_HOME: "/home/ada/corp" });
      // Upper case sorts first, so it also wins where a spawn merges the parent environment back.
      expect(yield* merge("win32")).toEqual({ HTTPS_PROXY: "http://gateway", PATH: "/bin" });
      expect(yield* merge("linux")).toEqual({
        HTTPS_PROXY: "http://mine",
        Https_Proxy: "http://gateway",
        PATH: "/bin",
      });
    }),
  );
});
