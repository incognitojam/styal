import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { EnvironmentCredentialPersistence } from "../persistence/EnvironmentPersistence.ts";

export class EnvironmentCredentialCreatePersistenceError extends Schema.TaggedError<EnvironmentCredentialCreatePersistenceError>()(
  "EnvironmentCredentialCreatePersistenceError",
  {
    stage: Schema.Literals([
      "generate-credential",
      "hash-token",
      "insert-credential",
      "revoke-previous-credentials",
    ]),
    environmentId: Schema.String,
    credentialId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment credential creation failed during '${this.stage}' for environment '${this.environmentId}'${this.credentialId === undefined ? "" : `, credential '${this.credentialId}'`}`;
  }
}

export class EnvironmentCredentialAuthenticatePersistenceError extends Schema.TaggedError<EnvironmentCredentialAuthenticatePersistenceError>()(
  "EnvironmentCredentialAuthenticatePersistenceError",
  {
    stage: Schema.Literals(["hash-token", "lookup-credential"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment credential authentication failed during '${this.stage}'`;
  }
}

export class EnvironmentCredentialRevokePersistenceError extends Schema.TaggedError<EnvironmentCredentialRevokePersistenceError>()(
  "EnvironmentCredentialRevokePersistenceError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to revoke credentials for environment '${this.environmentId}'`;
  }
}

export interface EnvironmentCredentialPrincipal {
  readonly credentialId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}

export class EnvironmentCredentials extends Context.Service<
  EnvironmentCredentials,
  {
    readonly create: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<string, EnvironmentCredentialCreatePersistenceError>;
    readonly authenticate: (
      token: string,
    ) => Effect.Effect<
      Option.Option<EnvironmentCredentialPrincipal>,
      EnvironmentCredentialAuthenticatePersistenceError
    >;
    readonly revokeForEnvironmentPublicKey: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<boolean, EnvironmentCredentialRevokePersistenceError>;
  }
>()("t3code-relay/environments/EnvironmentCredentials") {}

export const layer = Layer.effect(
  EnvironmentCredentials,
  Effect.map(EnvironmentCredentialPersistence, (store) => EnvironmentCredentials.of(store)),
);
