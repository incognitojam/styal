/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

import { vi } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SecureStore from "expo-secure-store";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { cryptoLayer, loadOrCreateDpopProofKeyPair } from "./dpop";
import { managedRelayClientLayer } from "./managedRelayLayer";

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  getRandomBytes: (byteCount: number) => new Uint8Array(NodeCrypto.randomBytes(byteCount)),
  getRandomBytesAsync: (byteCount: number) =>
    Promise.resolve(new Uint8Array(NodeCrypto.randomBytes(byteCount))),
  digest: (algorithm: string, data: Uint8Array) =>
    Promise.resolve(new Uint8Array(NodeCrypto.createHash(algorithm).update(data).digest()).buffer),
}));

const secureStore = new Map<string, string>();
let failNextRead = false;
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn((key: string) => {
    if (failNextRead) {
      failNextRead = false;
      return Promise.reject(new Error("keychain locked"));
    }
    return Promise.resolve(secureStore.get(key) ?? null);
  }),
  setItemAsync: (key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  },
  deleteItemAsync: (key: string) => {
    secureStore.delete(key);
    return Promise.resolve();
  },
}));

describe("managed relay DPoP signer", () => {
  it.effect("retries an interrupted native key read without clearing the saved key", () =>
    Effect.gen(function* () {
      const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
      const initialThumbprint = yield* loadOrCreateDpopProofKeyPair().pipe(
        Effect.provide(cryptoLayer),
        Effect.map((key) => key.thumbprint),
      );
      const savedKeys = new Map(secureStore);
      const readsBefore = vi.mocked(SecureStore.getItemAsync).mock.calls.length;
      const started = Promise.withResolvers<void>();
      const stalledRead = Promise.withResolvers<string | null>();
      vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(() => {
        started.resolve();
        return stalledRead.promise;
      });
      const first = yield* signer.thumbprint.pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(first);
      const recovered = yield* signer.thumbprint;
      assert.equal(recovered, initialThumbprint);
      assert.equal(yield* signer.thumbprint, recovered);
      assert.deepEqual(secureStore, savedKeys);
      assert.equal(vi.mocked(SecureStore.getItemAsync).mock.calls.length, readsBefore + 2);
      stalledRead.resolve(null);
    }).pipe(
      Effect.provide(
        managedRelayClientLayer("https://relay.example.test").pipe(
          Layer.provide(Layer.mergeAll(FetchHttpClient.layer, cryptoLayer)),
        ),
      ),
    ),
  );

  it.effect("loads the proof key again after a failed read", () =>
    Effect.gen(function* () {
      const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
      const readsBefore = vi.mocked(SecureStore.getItemAsync).mock.calls.length;
      failNextRead = true;
      const failed = yield* Effect.flip(signer.thumbprint);
      assert.equal(failed._tag, "ManagedRelayDpopKeyLoadError");

      // The failure was not kept: the next request reads the key store again.
      const thumbprint = yield* signer.thumbprint;
      assert.equal(yield* signer.thumbprint, thumbprint);
      assert.equal(vi.mocked(SecureStore.getItemAsync).mock.calls.length, readsBefore + 2);
    }).pipe(
      Effect.provide(
        managedRelayClientLayer("https://relay.example.test").pipe(
          Layer.provide(Layer.mergeAll(FetchHttpClient.layer, cryptoLayer)),
        ),
      ),
    ),
  );
});
