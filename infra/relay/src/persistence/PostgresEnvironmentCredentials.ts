import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, eq, exists, isNull, ne, notExists } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import * as RelayDb from "../db.ts";
import { relayEnvironmentCredentials, relayEnvironmentLinks } from "./schema.ts";

import {
  EnvironmentCredentialCreatePersistenceError,
  EnvironmentCredentialAuthenticatePersistenceError,
  EnvironmentCredentialRevokePersistenceError,
} from "../environments/EnvironmentCredentials.ts";
import { EnvironmentCredentialPersistence } from "./EnvironmentPersistence.ts";

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const hashToken = (token: string) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(token))
      .pipe(Effect.map(Base64Url.encode));
  const randomTokenPart = (segments: number) =>
    Effect.map(Effect.all(Array.from({ length: segments }, () => random.uuidV4())), (values) =>
      values.join("").replaceAll("-", ""),
    );
  const makeCredential = Effect.fnUntraced(function* () {
    const credentialId = yield* randomTokenPart(2);
    const secret = yield* randomTokenPart(3);
    return {
      credentialId,
      token: `t3env_${credentialId}_${secret}`,
    };
  });

  return EnvironmentCredentialPersistence.of({
    create: Effect.fn("relay.environment_credentials.create")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      const credential = yield* makeCredential().pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentCredentialCreatePersistenceError({
              stage: "generate-credential",
              environmentId: input.environmentId,
              cause,
            }),
        ),
      );
      const credentialHash = yield* hashToken(credential.token).pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentCredentialCreatePersistenceError({
              stage: "hash-token",
              environmentId: input.environmentId,
              credentialId: credential.credentialId,
              cause,
            }),
        ),
      );
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* db
        .insert(relayEnvironmentCredentials)
        .values({
          credentialId: credential.credentialId,
          environmentId: input.environmentId,
          environmentPublicKey: input.environmentPublicKey,
          credentialHash,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentCredentialCreatePersistenceError({
                stage: "insert-credential",
                environmentId: input.environmentId,
                credentialId: credential.credentialId,
                cause,
              }),
          ),
        );
      yield* db
        .update(relayEnvironmentCredentials)
        .set({
          revokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(relayEnvironmentCredentials.environmentId, input.environmentId),
            eq(relayEnvironmentCredentials.environmentPublicKey, input.environmentPublicKey),
            ne(relayEnvironmentCredentials.credentialId, credential.credentialId),
            isNull(relayEnvironmentCredentials.revokedAt),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentCredentialCreatePersistenceError({
                stage: "revoke-previous-credentials",
                environmentId: input.environmentId,
                credentialId: credential.credentialId,
                cause,
              }),
          ),
        );
      return credential.token;
    }),

    authenticate: Effect.fn("relay.environment_credentials.authenticate")(function* (token) {
      const credentialHash = yield* hashToken(token).pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentCredentialAuthenticatePersistenceError({
              stage: "hash-token",
              cause,
            }),
        ),
      );
      const rows = yield* db
        .select({
          credentialId: relayEnvironmentCredentials.credentialId,
          environmentId: relayEnvironmentCredentials.environmentId,
          environmentPublicKey: relayEnvironmentCredentials.environmentPublicKey,
        })
        .from(relayEnvironmentCredentials)
        .where(
          and(
            eq(relayEnvironmentCredentials.credentialHash, credentialHash),
            isNull(relayEnvironmentCredentials.revokedAt),
            exists(
              new QueryBuilder()
                .select({ userId: relayEnvironmentLinks.userId })
                .from(relayEnvironmentLinks)
                .where(
                  and(
                    eq(
                      relayEnvironmentLinks.environmentId,
                      relayEnvironmentCredentials.environmentId,
                    ),
                    eq(
                      relayEnvironmentLinks.environmentPublicKey,
                      relayEnvironmentCredentials.environmentPublicKey,
                    ),
                    isNull(relayEnvironmentLinks.revokedAt),
                  ),
                ),
            ),
          ),
        )
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentCredentialAuthenticatePersistenceError({
                stage: "lookup-credential",
                cause,
              }),
          ),
        );
      const row = rows[0];
      if (row) {
        yield* Effect.annotateCurrentSpan({ "relay.environment_id": row.environmentId });
      }
      return row
        ? Option.some({
            credentialId: row.credentialId,
            environmentId: row.environmentId,
            environmentPublicKey: row.environmentPublicKey,
          })
        : Option.none();
    }),

    revokeForEnvironmentPublicKey: Effect.fn(
      "relay.environment_credentials.revoke_for_environment_public_key",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      const revokedAt = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .update(relayEnvironmentCredentials)
        .set({
          revokedAt,
          updatedAt: revokedAt,
        })
        .where(
          and(
            eq(relayEnvironmentCredentials.environmentId, input.environmentId),
            eq(relayEnvironmentCredentials.environmentPublicKey, input.environmentPublicKey),
            isNull(relayEnvironmentCredentials.revokedAt),
            notExists(
              new QueryBuilder()
                .select({ userId: relayEnvironmentLinks.userId })
                .from(relayEnvironmentLinks)
                .where(
                  and(
                    eq(relayEnvironmentLinks.environmentId, input.environmentId),
                    eq(relayEnvironmentLinks.environmentPublicKey, input.environmentPublicKey),
                    isNull(relayEnvironmentLinks.revokedAt),
                  ),
                ),
            ),
          ),
        )
        .returning({
          credentialId: relayEnvironmentCredentials.credentialId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentCredentialRevokePersistenceError({
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
      return rows.length > 0;
    }),
  });
});

export const layer = Layer.effect(EnvironmentCredentialPersistence, make);
