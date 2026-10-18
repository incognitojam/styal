import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import {
  makeLegacyClerkCliConfig,
  makeRelayUrlConfig,
  resolveRelayClientTracingConfig,
} from "./publicConfig.ts";

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("rejects an insecure runtime relay URL override", () =>
  makeRelayUrlConfig("https://embedded.example.test").pipe(
    provideEnv({ T3CODE_RELAY_URL: "http://runtime.example.test" }),
    Effect.flip,
  ),
);

it.effect("derives the legacy Clerk token endpoint from statically injected public config", () =>
  Effect.gen(function* () {
    const config = yield* makeLegacyClerkCliConfig({
      clerkPublishableKeyFallback: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
      clerkCliOAuthClientIdFallback: "oauth_client_embedded",
    }).pipe(provideEnv({}));

    assert.deepEqual(config, {
      tokenEndpoint: "https://clerk.example.test/oauth/token",
      clientId: "oauth_client_embedded",
    });
  }),
);

it("product opt-out disables relay tracing with either built-in or runtime credentials", () => {
  const fallback = {
    tracesUrl: "https://embedded.example.test/v1/traces",
    tracesDataset: "embedded-dataset",
    tracesToken: "embedded-token",
  };
  const env = {
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "false",
  };

  assert.equal(resolveRelayClientTracingConfig(env, fallback), null);
  assert.equal(
    resolveRelayClientTracingConfig(
      {
        ...env,
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://runtime.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "runtime-dataset",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "runtime-token",
      },
      fallback,
    ),
    null,
  );
});
