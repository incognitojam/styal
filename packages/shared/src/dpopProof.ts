import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { importJWK, SignJWT, type CryptoKey, type JWK } from "jose";

import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  DpopPublicJwk,
  normalizeDpopHtu,
} from "./dpop.ts";

/** An ES256 key that signs DPoP proofs (RFC 9449). */
export interface DpopProofKey {
  readonly privateKey: CryptoKey;
  readonly publicJwk: DpopPublicJwk;
  readonly thumbprint: string;
}

/** A P-256 private key in JWK form, for callers that persist the key themselves. */
export const DpopPrivateJwk = Schema.Struct({
  ...DpopPublicJwk.fields,
  d: Schema.String.check(Schema.isNonEmpty()),
});
export type DpopPrivateJwk = typeof DpopPrivateJwk.Type;

export class DpopProofError extends Schema.TaggedError<DpopProofError>()("DpopProofError", {
  operation: Schema.Literals(["generate", "import", "sign"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    switch (this.operation) {
      case "generate":
        return "Could not generate a DPoP proof key.";
      case "import":
        return "Could not import the DPoP proof key.";
      case "sign":
        return "Could not sign a DPoP proof.";
    }
  }
}

const decodeDpopPrivateJwk = Schema.decodeUnknownEffect(DpopPrivateJwk);

/** Generates a new P-256 key and returns its private JWK. */
export const generateDpopPrivateJwk: Effect.Effect<DpopPrivateJwk, DpopProofError> = Effect.gen(
  function* () {
    const generated = yield* Effect.tryPromise({
      try: () =>
        globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
          "sign",
          "verify",
        ]),
      catch: (cause) => new DpopProofError({ operation: "generate", cause }),
    });
    const exported = yield* Effect.tryPromise({
      try: () => globalThis.crypto.subtle.exportKey("jwk", generated.privateKey),
      catch: (cause) => new DpopProofError({ operation: "generate", cause }),
    });
    return yield* decodeDpopPrivateJwk(exported).pipe(
      Effect.mapError((cause) => new DpopProofError({ operation: "generate", cause })),
    );
  },
);

/**
 * Imports a private JWK as a signing key. The imported key is not extractable,
 * so only the caller's own copy of the JWK can leave the process.
 */
export const importDpopProofKey = (
  privateJwk: DpopPrivateJwk,
): Effect.Effect<DpopProofKey, DpopProofError> =>
  Effect.gen(function* () {
    const publicJwk: DpopPublicJwk = {
      kty: privateJwk.kty,
      crv: privateJwk.crv,
      x: privateJwk.x,
      y: privateJwk.y,
    };
    const privateKey = yield* Effect.tryPromise({
      try: () =>
        importJWK({ ...privateJwk } satisfies JWK, "ES256", {
          extractable: false,
        }) as Promise<CryptoKey>,
      catch: (cause) => new DpopProofError({ operation: "import", cause }),
    });
    return { privateKey, publicJwk, thumbprint: computeDpopJwkThumbprint(publicJwk) };
  });

/**
 * Signs a DPoP proof for one request. Pass `accessToken` when the request
 * presents a DPoP-bound access token, so the proof carries its `ath` hash.
 */
export const signDpopProof = (input: {
  readonly key: DpopProofKey;
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string;
}): Effect.Effect<string, DpopProofError, Crypto.Crypto> =>
  Effect.gen(function* () {
    const htu = normalizeDpopHtu(input.url);
    if (htu === null) {
      return yield* new DpopProofError({
        operation: "sign",
        cause: new Error("DPoP proof URL is not absolute."),
      });
    }
    const crypto = yield* Crypto.Crypto;
    const jti = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => new DpopProofError({ operation: "sign", cause })),
    );
    const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    return yield* Effect.tryPromise({
      try: () =>
        new SignJWT({
          htm: input.method.toUpperCase(),
          htu,
          jti,
          ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
        })
          .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: input.key.publicJwk })
          .setIssuedAt(issuedAt)
          .sign(input.key.privateKey),
      catch: (cause) => new DpopProofError({ operation: "sign", cause }),
    });
  });
