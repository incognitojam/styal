import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
  RelayManagedEndpoint,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { EnvironmentLinkPersistence } from "../persistence/EnvironmentPersistence.ts";

export interface RelayLinkedEnvironmentRecord extends RelayClientEnvironmentRecord {
  readonly environmentPublicKey: string;
}

export interface AgentAwarenessDeliveryUserRecord {
  readonly userId: string;
  readonly notificationsEnabled: boolean;
  readonly liveActivitiesEnabled: boolean;
}

export class EnvironmentLinkUpsertPersistenceError extends Schema.TaggedError<EnvironmentLinkUpsertPersistenceError>()(
  "EnvironmentLinkUpsertPersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    deviceId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkUserListPersistenceError extends Schema.TaggedError<EnvironmentLinkUserListPersistenceError>()(
  "EnvironmentLinkUserListPersistenceError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment link user query 'list-delivery-users' failed for environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkListPersistenceError extends Schema.TaggedError<EnvironmentLinkListPersistenceError>()(
  "EnvironmentLinkListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list environment links for user '${this.userId}'`;
  }
}

export class EnvironmentLinkLookupPersistenceError extends Schema.TaggedError<EnvironmentLinkLookupPersistenceError>()(
  "EnvironmentLinkLookupPersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to look up environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkEnvironmentLookupPersistenceError extends Schema.TaggedError<EnvironmentLinkEnvironmentLookupPersistenceError>()(
  "EnvironmentLinkEnvironmentLookupPersistenceError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to look up active managed links for environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkRevokePersistenceError extends Schema.TaggedError<EnvironmentLinkRevokePersistenceError>()(
  "EnvironmentLinkRevokePersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to revoke environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinks extends Context.Service<
  EnvironmentLinks,
  {
    readonly upsert: (input: {
      readonly userId: string;
      readonly request: RelayEnvironmentLinkRequest;
      readonly proof: RelayEnvironmentLinkProofPayload;
      readonly endpoint: RelayManagedEndpoint;
    }) => Effect.Effect<void, EnvironmentLinkUpsertPersistenceError>;
    readonly listDeliveryUsersForEnvironment: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<
      ReadonlyArray<AgentAwarenessDeliveryUserRecord>,
      EnvironmentLinkUserListPersistenceError
    >;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<
      ReadonlyArray<RelayClientEnvironmentRecord>,
      EnvironmentLinkListPersistenceError
    >;
    readonly getForUser: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<RelayLinkedEnvironmentRecord | null, EnvironmentLinkLookupPersistenceError>;
    /** Narrow by user or proven key: a public environment id alone does not authorize access to its links. */
    readonly findActiveManagedForEnvironment: (input: {
      readonly environmentId: string;
      readonly userId?: string;
      readonly environmentPublicKey?: string;
    }) => Effect.Effect<
      ReadonlyArray<
        RelayLinkedEnvironmentRecord & {
          readonly userId: string;
          readonly holdWebhooksWhileOffline: boolean;
        }
      >,
      EnvironmentLinkEnvironmentLookupPersistenceError
    >;
    readonly setHoldWebhooksWhileOffline: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly holdWebhooksWhileOffline: boolean;
    }) => Effect.Effect<void, EnvironmentLinkEnvironmentLookupPersistenceError>;
    readonly revokeForUser: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<boolean, EnvironmentLinkRevokePersistenceError>;
  }
>()("t3code-relay/environments/EnvironmentLinks") {}

export const layer = Layer.effect(
  EnvironmentLinks,
  Effect.map(EnvironmentLinkPersistence, (store) => EnvironmentLinks.of(store)),
);
