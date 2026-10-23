import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";

export const AGENT_AWARENESS_BACKGROUND_KEYS = [
  "styal.agent-awareness.device-id",
  "styal.agent-awareness.registration",
];

function storageOptions(key: string): SecureStore.SecureStoreOptions | undefined {
  return AGENT_AWARENESS_BACKGROUND_KEYS.includes(key)
    ? { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }
    : undefined;
}

const MobileSecureStorageOperation = Schema.Literals(["read", "write", "delete"]);

export class MobileSecureStorageError extends Schema.TaggedError<MobileSecureStorageError>()(
  "MobileSecureStorageError",
  {
    operation: MobileSecureStorageOperation,
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Mobile secure storage operation ${this.operation} failed for key ${this.key}.`;
  }
}

export class MobileSecureStorage extends Context.Service<
  MobileSecureStorage,
  {
    readonly getItem: (key: string) => Effect.Effect<string | null, MobileSecureStorageError>;
    readonly setItem: (key: string, value: string) => Effect.Effect<void, MobileSecureStorageError>;
    readonly removeItem: (key: string) => Effect.Effect<void, MobileSecureStorageError>;
  }
>()("@t3tools/mobile/persistence/MobileSecureStorage") {}

export const make = MobileSecureStorage.of({
  getItem: Effect.fn("MobileSecureStorage.getItem")((key) =>
    Effect.tryPromise({
      try: () => SecureStore.getItemAsync(key, storageOptions(key)),
      catch: (cause) => new MobileSecureStorageError({ operation: "read", key, cause }),
    }),
  ),
  setItem: Effect.fn("MobileSecureStorage.setItem")((key, value) =>
    Effect.tryPromise({
      try: () => SecureStore.setItemAsync(key, value, storageOptions(key)),
      catch: (cause) => new MobileSecureStorageError({ operation: "write", key, cause }),
    }),
  ),
  removeItem: Effect.fn("MobileSecureStorage.removeItem")((key) =>
    Effect.tryPromise({
      try: () => SecureStore.deleteItemAsync(key, storageOptions(key)),
      catch: (cause) => new MobileSecureStorageError({ operation: "delete", key, cause }),
    }),
  ),
});

export const layer = Layer.succeed(MobileSecureStorage, make);
