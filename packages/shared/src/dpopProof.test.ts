import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { computeDpopAccessTokenHash, verifyDpopProof } from "./dpop.ts";
import {
  DpopPrivateJwk,
  generateDpopPrivateJwk,
  importDpopProofKey,
  signDpopProof,
} from "./dpopProof.ts";

const decodeProofPayloadJson = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      htu: Schema.String,
      iat: Schema.Number,
      ath: Schema.optional(Schema.String),
    }),
  ),
);
const decodeProofPayload = (proof: string) =>
  decodeProofPayloadJson(Buffer.from(proof.split(".")[1]!, "base64url").toString("utf8"));
const decodeDpopPrivateJwkJson = Schema.decodeEffect(Schema.fromJsonString(DpopPrivateJwk));

it.layer(NodeServices.layer)("dpopProof", (it) => {
  it.effect("signs proofs the shared verifier accepts for the same key", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_000);
      const key = yield* generateDpopPrivateJwk.pipe(Effect.flatMap(importDpopProofKey));

      const proof = yield* signDpopProof({
        key,
        method: "post",
        url: "https://relay.example.test/v1/auth/token?ignored=1#fragment",
      });

      const result = verifyDpopProof({
        proof,
        method: "POST",
        url: "https://relay.example.test/v1/auth/token",
        nowEpochSeconds: 1_700_000_000,
        expectedThumbprint: key.thumbprint,
      });
      assert.deepInclude(result, { ok: true, thumbprint: key.thumbprint, iat: 1_700_000_000 });
      const payload = decodeProofPayload(proof);
      assert.equal(payload.htu, "https://relay.example.test/v1/auth/token");
      assert.isUndefined(payload.ath);
    }),
  );

  it.effect("binds the proof to an access token through ath", () =>
    Effect.gen(function* () {
      const nowEpochSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
      const key = yield* generateDpopPrivateJwk.pipe(Effect.flatMap(importDpopProofKey));
      const proof = yield* signDpopProof({
        key,
        method: "DELETE",
        url: "https://relay.example.test/v1/client/environment-links/env-1",
        accessToken: "access-token-1",
      });

      const verify = (accessToken: string) =>
        verifyDpopProof({
          proof,
          method: "DELETE",
          url: "https://relay.example.test/v1/client/environment-links/env-1",
          nowEpochSeconds,
          expectedAccessToken: accessToken,
        });
      assert.isTrue(verify("access-token-1").ok);
      assert.deepInclude(verify("access-token-2"), {
        ok: false,
        code: "access_token_hash_mismatch",
      });
      assert.equal(decodeProofPayload(proof).ath, computeDpopAccessTokenHash("access-token-1"));
    }),
  );

  it.effect("keeps the same thumbprint when a persisted JWK is imported again", () =>
    Effect.gen(function* () {
      const nowEpochSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
      const privateJwk = yield* generateDpopPrivateJwk;
      const restored = yield* decodeDpopPrivateJwkJson(JSON.stringify(privateJwk));
      const first = yield* importDpopProofKey(privateJwk);
      const second = yield* importDpopProofKey(restored);
      assert.equal(second.thumbprint, first.thumbprint);

      const proof = yield* signDpopProof({
        key: second,
        method: "POST",
        url: "https://relay.example.test/v1/auth/token",
      });
      assert.isTrue(
        verifyDpopProof({
          proof,
          method: "POST",
          url: "https://relay.example.test/v1/auth/token",
          nowEpochSeconds,
          expectedThumbprint: first.thumbprint,
        }).ok,
      );
    }),
  );
});
