import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Base64Url from "effect/encoding/Base64Url";

import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  DpopPublicJwk,
  normalizeDpopHtu,
} from "./dpop.ts";

/** An ES256 key that signs DPoP proofs (RFC 9449). */
export interface DpopProofKey {
  readonly privateKey: Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;
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
export const importDpopProofKey = Effect.fn("dpopProof.importDpopProofKey")(function* (
  privateJwk: DpopPrivateJwk,
): Effect.fn.Return<DpopProofKey, DpopProofError> {
  const publicJwk: DpopPublicJwk = {
    kty: privateJwk.kty,
    crv: privateJwk.crv,
    x: privateJwk.x,
    y: privateJwk.y,
  };
  const privateKey = yield* Effect.tryPromise({
    try: () =>
      globalThis.crypto.subtle.importKey(
        "jwk",
        privateJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ),
    catch: (cause) => new DpopProofError({ operation: "import", cause }),
  });
  return { privateKey, publicJwk, thumbprint: computeDpopJwkThumbprint(publicJwk) };
});

/**
 * Signs a DPoP proof for one request. Pass `accessToken` when the request
 * presents a DPoP-bound access token, so the proof carries its `ath` hash.
 */
export const signDpopProof = Effect.fn("dpopProof.signDpopProof")(function* (input: {
  readonly key: DpopProofKey;
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string;
}): Effect.fn.Return<string, DpopProofError, SecureRandom.SecureRandom> {
  const htu = normalizeDpopHtu(input.url);
  if (htu === null) {
    return yield* new DpopProofError({
      operation: "sign",
      cause: new Error("DPoP proof URL is not absolute."),
    });
  }
  const crypto = yield* SecureRandom.SecureRandom;
  const jti = yield* crypto
    .uuidV4()
    .pipe(Effect.mapError((cause) => new DpopProofError({ operation: "sign", cause })));
  const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
  const encode = (value: unknown) =>
    Base64Url.encode(new TextEncoder().encode(JSON.stringify(value)));
  const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk: input.key.publicJwk });
  const payload = encode({
    htm: input.method.toUpperCase(),
    htu,
    jti,
    iat: issuedAt,
    ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
  });
  const signingInput = `${header}.${payload}`;
  const signature = yield* Effect.tryPromise({
    try: () =>
      globalThis.crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        input.key.privateKey,
        new TextEncoder().encode(signingInput),
      ),
    catch: (cause) => new DpopProofError({ operation: "sign", cause }),
  });
  return `${signingInput}.${Base64Url.encode(new Uint8Array(signature))}`;
});
