import type {
  RelayDeviceRegistrationRequest,
  RelayAgentActivityAggregateState,
} from "@t3tools/contracts/relay";
import type { IdentityCommand, StoredSession } from "./AccountIdentity.ts";
import type { TokenReference } from "./PushTokenObject.ts";
import { canonicalJson, summarize } from "./storage.ts";

export const registrationMigration =
  "CREATE TABLE account_registrations (device_id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE account_registration_owner (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), user_id TEXT NOT NULL); CREATE TABLE registration_token_references (operation_id TEXT PRIMARY KEY, reference TEXT NOT NULL)";
export const registrationOutcomeMigration =
  "CREATE TABLE registration_outcomes (operation_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('completed', 'cancelled')), input TEXT NOT NULL, reason TEXT)";
type Rejection = "session-revoked" | "device-not-owned";
type Outcome = {
  status: "completed" | "cancelled";
  input: string;
  reason: Rejection | null;
};
export interface RegisteredDevice {
  registration: RelayDeviceRegistrationRequest;
  sessionId: string | null;
  push: TokenReference | null;
  start: TokenReference | null;
  createdAt: string;
  updatedAt: string;
}
export interface RegisteredActivity {
  token: TokenReference | null;
  createdAt: string;
  remoteStartQueuedAt: string | null;
  remoteStartedAt: string | null;
  endedAt: string | null;
  aggregate: RelayAgentActivityAggregateState | null;
  deliveredAt: string | null;
  updatedAt: string;
}
export interface RegistrationCandidate {
  device: RegisteredDevice | null;
  activity: RegisteredActivity | null;
}
export type RegistrationInput =
  | { kind: "device"; sessionId?: string; registration: RelayDeviceRegistrationRequest }
  | {
      kind: "activity";
      sessionId?: string;
      registration: { deviceId: string; activityPushToken: string };
    };
export interface RegistrationIntent {
  id: string;
  input: RegistrationInput;
  now: string;
  candidate: RegistrationCandidate | null;
  claims: Array<{ reference: TokenReference; expected: number }>;
  cancelling?: Rejection;
}
export interface RegistrationRecord {
  deviceId: string;
  active: RegistrationCandidate;
  pending: RegistrationIntent | null;
}
export type RegistrationCommand =
  | { kind: "read"; now: string }
  | { kind: "begin"; id: string; input: RegistrationInput; now: string; registered?: true }
  | {
      kind: "ready";
      deviceId: string;
      id: string;
      candidate: RegistrationCandidate;
      claims: RegistrationIntent["claims"];
      now: string;
    }
  | { kind: "finish"; deviceId: string; id: string }
  | { kind: "cancel"; deviceId: string; id: string }
  | { kind: "check"; deviceId: string; id: string; now: string }
  | { kind: "abort"; deviceId: string; id: string }
  | { kind: "remove"; deviceId: string }
  | {
      kind: "mark";
      deviceId: string;
      end: boolean;
      keepToken: boolean;
      registered?: true;
      aggregate: RelayAgentActivityAggregateState | null;
      now: string;
    }
  | { kind: "invalidate"; deviceId: string; push: boolean; token?: string; now?: string };

export const tokenReferences = (candidate: RegistrationCandidate) =>
  [candidate.device?.push, candidate.device?.start, candidate.activity?.token].filter(
    (ref): ref is TokenReference => !!ref,
  );
export const registrationRecords = (storage: DurableObjectStorage) =>
  storage.sql
    .exec<{ value: string }>("SELECT value FROM account_registrations ORDER BY rowid")
    .toArray()
    .map((row) => JSON.parse(row.value) as RegistrationRecord);
const save = (storage: DurableObjectStorage, record: RegistrationRecord) =>
  storage.sql.exec(
    "INSERT INTO account_registrations VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET value = excluded.value",
    record.deviceId,
    canonicalJson(record),
  );
const outcome = (storage: DurableObjectStorage, id: string) =>
  storage.sql
    .exec<Outcome>(
      "SELECT status, input, reason FROM registration_outcomes WHERE operation_id = ?",
      id,
    )
    .toArray()[0];
const settleOutcome = (
  storage: DurableObjectStorage,
  intent: RegistrationIntent,
  status: Outcome["status"],
  reason: Rejection | null = null,
) =>
  storage.sql.exec(
    "INSERT INTO registration_outcomes VALUES (?, ?, ?, ?)",
    intent.id,
    status,
    canonicalJson(intent.input),
    reason,
  );
export function liveRegistrationSession(
  storage: DurableObjectStorage,
  sessionId: string,
  now: string,
) {
  const value = storage.sql
    .exec<{ value: string }>("SELECT value FROM account_sessions WHERE session_id = ?", sessionId)
    .toArray()[0]?.value;
  const session = value ? (JSON.parse(value) as StoredSession) : null;
  return !!session && session.published && !session.revoked && session.expiresAt > now;
}
function validate(
  storage: DurableObjectStorage,
  input: RegistrationInput,
  active: RegistrationCandidate,
  now: string,
) {
  if (input.kind === "device" ? !!input.sessionId : input.sessionId !== undefined) {
    const sessionId = input.sessionId ?? "";
    if (!liveRegistrationSession(storage, sessionId, now)) return "session-revoked" as const;
    if (input.kind === "activity" && active.device?.sessionId !== sessionId)
      return "device-not-owned" as const;
  }
  return null;
}
export function registrations(
  storage: DurableObjectStorage,
  userId: string,
  command: RegistrationCommand,
) {
  return storage.transactionSync(() => {
    const records = registrationRecords(storage);
    if (command.kind === "read")
      return {
        records,
        liveSessionIds: storage.sql
          .exec<{ value: string }>("SELECT value FROM account_sessions")
          .toArray()
          .map((row) => JSON.parse(row.value) as StoredSession)
          .filter(
            (session) => session.published && !session.revoked && session.expiresAt > command.now,
          )
          .map((session) => session.sessionId),
      };
    const deviceId =
      command.kind === "begin" ? command.input.registration.deviceId : command.deviceId;
    const record = records.find((row) => row.deviceId === deviceId) ?? {
      deviceId,
      active: { device: null, activity: null },
      pending: null,
    };
    if (command.kind === "begin") {
      const previous = outcome(storage, command.id);
      if (previous) {
        if (previous.input !== canonicalJson(command.input))
          throw new Error("Registration operation intent mismatch");
        return previous.status === "completed"
          ? { completed: true }
          : { error: previous.reason ?? ("operation-cancelled" as const) };
      }
      if (record.pending) {
        if (
          record.pending.id === command.id &&
          canonicalJson(record.pending.input) !== canonicalJson(command.input)
        )
          throw new Error("Registration operation intent mismatch");
        return { record };
      }
      const error = validate(storage, command.input, record.active, command.now);
      if (error) return { error };
      if (
        !command.registered &&
        !records.length &&
        !storage.sql.exec("SELECT 1 FROM account_identity").toArray().length &&
        !storage.sql.exec("SELECT 1 FROM account_registration_owner").toArray().length
      )
        return { needsRegistration: true };
      if (!record.pending) {
        storage.sql.exec("INSERT OR IGNORE INTO account_registration_owner VALUES (1, ?)", userId);
        record.pending = {
          id: command.id,
          input: command.input,
          now: command.now,
          candidate: null,
          claims: [],
        };
        save(storage, record);
      }
      return { record };
    }
    switch (command.kind) {
      case "check": {
        const pending = record.pending;
        if (pending?.id !== command.id || !pending.candidate) {
          const previous = outcome(storage, command.id);
          return { status: previous?.status ?? "stale", reason: previous?.reason ?? null };
        }
        if (pending.cancelling) return { status: "cancel", reason: pending.cancelling } as const;
        const reason = validate(storage, pending.input, record.active, command.now);
        if (reason !== null) {
          pending.cancelling = reason;
          save(storage, record);
          return { status: "cancel", reason } as const;
        }
        return { status: "ready" } as const;
      }
      case "abort":
        if (record.pending?.id === command.id && record.pending.cancelling) {
          settleOutcome(storage, record.pending, "cancelled", record.pending.cancelling);
          record.pending = null;
          save(storage, record);
        }
        return { applied: true };
      case "ready": {
        if (record.pending?.id !== command.id) return { applied: false };
        if (record.pending.candidate) return { applied: true, record };
        const error = validate(storage, record.pending.input, record.active, command.now);
        if (error) {
          settleOutcome(storage, record.pending, "cancelled", error);
          record.pending = null;
          save(storage, record);
          return { error };
        }
        record.pending.candidate = command.candidate;
        record.pending.claims = command.claims;
        for (const reference of tokenReferences(command.candidate))
          storage.sql.exec(
            "INSERT OR IGNORE INTO registration_token_references VALUES (?, ?)",
            reference.operationId,
            canonicalJson(reference),
          );
        save(storage, record);
        return { applied: true, record };
      }
      case "finish":
        if (
          record.pending?.id !== command.id ||
          !record.pending.candidate ||
          record.pending.cancelling
        )
          return { applied: false };
        record.active = record.pending.candidate;
        settleOutcome(storage, record.pending, "completed");
        record.pending = null;
        save(storage, record);
        return { applied: true };
      case "cancel":
        if (record.pending?.id === command.id && !record.pending.candidate) {
          settleOutcome(storage, record.pending, "cancelled");
          record.pending = null;
          save(storage, record);
        }
        return { applied: true };
      case "remove":
        if (record.pending) return { busy: true };
        storage.sql.exec("DELETE FROM account_registrations WHERE device_id = ?", deviceId);
        return { applied: true };
      case "mark": {
        if (record.pending) return { busy: true };
        if (
          !command.registered &&
          !records.length &&
          !storage.sql.exec("SELECT 1 FROM account_identity").toArray().length &&
          !storage.sql.exec("SELECT 1 FROM account_registration_owner").toArray().length
        )
          return { needsRegistration: true };
        storage.sql.exec("INSERT OR IGNORE INTO account_registration_owner VALUES (1, ?)", userId);
        const old = record.active.activity;
        record.active.activity = {
          token: command.keepToken ? (old?.token ?? null) : null,
          createdAt: old?.createdAt ?? command.now,
          remoteStartQueuedAt: null,
          remoteStartedAt: old?.remoteStartedAt ?? null,
          endedAt: command.end ? command.now : (old?.endedAt ?? null),
          aggregate: command.aggregate,
          deliveredAt: command.now,
          updatedAt: command.now,
        };
        save(storage, record);
        return { applied: true };
      }
      case "invalidate": {
        if (record.pending) return { busy: true };
        if (command.push) {
          if (
            record.active.device &&
            (command.token === undefined || record.active.device.push?.token === command.token)
          ) {
            record.active.device.push = null;
            if (command.now) record.active.device.updatedAt = command.now;
          }
        } else if (record.active.activity) {
          record.active.activity.token = null;
          record.active.activity.remoteStartQueuedAt = null;
          record.active.activity.remoteStartedAt = null;
          record.active.activity.endedAt = command.now ?? record.active.activity.endedAt;
          if (command.now) record.active.activity.updatedAt = command.now;
        }
        if (records.some((row) => row.deviceId === deviceId)) save(storage, record);
        return { applied: true };
      }
    }
  });
}

export function registrationRemoval(storage: DurableObjectStorage, command: IdentityCommand) {
  const sessions = storage.sql
    .exec<{ value: string }>("SELECT value FROM account_sessions")
    .toArray()
    .map((row) => JSON.parse(row.value) as StoredSession);
  const sessionIds = sessions
    .filter((session) => {
      if (command.kind === "prune-sessions") return session.expiresAt <= command.now;
      if (command.kind === "revoke-session")
        return session.sessionId === command.sessionId && !session.revoked;
      if (command.kind === "publish-session")
        return session.sessionId === command.sessionId && !session.revoked;
      return (
        command.kind === "use-session" &&
        command.revoke &&
        session.sessionId === command.sessionId &&
        session.published &&
        !session.revoked &&
        session.expiresAt > command.now &&
        session.tokenHash === command.tokenHash &&
        session.thumbprint === command.thumbprint
      );
    })
    .map((session) => session.sessionId);
  return {
    sessionIds,
    records: removalRecords(storage, sessionIds),
    stamp: canonicalJson(removalRecords(storage, sessionIds)),
  };
}
export function removalRecords(storage: DurableObjectStorage, sessionIds: readonly string[]) {
  return registrationRecords(storage).filter(
    (record) =>
      sessionIds.includes(record.active.device?.sessionId ?? "") ||
      sessionIds.includes(record.pending?.candidate?.device?.sessionId ?? "") ||
      sessionIds.includes(record.pending?.input.sessionId ?? ""),
  );
}
export function endSessionRegistrations(
  storage: DurableObjectStorage,
  sessionIds: readonly string[],
) {
  for (const record of removalRecords(storage, sessionIds)) {
    if (sessionIds.includes(record.active.device?.sessionId ?? ""))
      record.active = { device: null, activity: null };
    if (
      sessionIds.includes(record.pending?.input.sessionId ?? "") ||
      sessionIds.includes(record.pending?.candidate?.device?.sessionId ?? "")
    )
      record.pending = null;
    if (!record.active.device && !record.active.activity && !record.pending)
      storage.sql.exec("DELETE FROM account_registrations WHERE device_id = ?", record.deviceId);
    else save(storage, record);
  }
}
export function registrationInventory(storage: DurableObjectStorage) {
  const records = registrationRecords(storage);
  return [
    summarize(
      "registration_outcomes",
      storage.sql.exec("SELECT * FROM registration_outcomes ORDER BY operation_id"),
    ),
    summarize(
      "registration_token_references",
      storage.sql.exec("SELECT reference FROM registration_token_references ORDER BY operation_id"),
    ),
    summarize(
      "relay_mobile_devices",
      records.flatMap((row) =>
        row.active.device ? [{ deviceId: row.deviceId, ...row.active.device }] : [],
      ),
    ),
    summarize(
      "relay_live_activities",
      records.flatMap((row) =>
        row.active.activity ? [{ deviceId: row.deviceId, ...row.active.activity }] : [],
      ),
    ),
    summarize(
      "registration_operations",
      records.flatMap((row) => (row.pending ? [row.pending] : [])),
    ),
  ];
}
