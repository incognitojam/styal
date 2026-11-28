import type {
  RelayDeviceRegistrationRequest,
  RelayAgentActivityAggregateState,
} from "@t3tools/contracts/relay";
import type { IdentityCommand, StoredSession } from "./AccountIdentity.ts";
import * as DateTime from "effect/DateTime";
import type { TokenReference, TokenPreparation } from "./TokenProtocol.ts";
import { registrationDigest, tokenClaimDigest } from "./TokenProtocol.ts";
import { canonicalJson, summarize } from "./storage.ts";

export const registrationMigration =
  "CREATE TABLE account_registrations (device_id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE account_registration_owner (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), user_id TEXT NOT NULL); CREATE TABLE registration_token_references (operation_id TEXT PRIMARY KEY, reference TEXT NOT NULL)";
export const registrationOutcomeMigration =
  "CREATE TABLE registration_outcomes (operation_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('completed', 'cancelled')), input TEXT NOT NULL, reason TEXT)";
export const registrationEndMigration =
  "CREATE TABLE registration_ends (reference_id TEXT PRIMARY KEY, value TEXT NOT NULL)";
export const registrationHistoryMigration =
  "CREATE TABLE registration_retention (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), cutoff TEXT NOT NULL, codec INTEGER NOT NULL); INSERT INTO registration_retention VALUES (1, '', 0); CREATE TABLE registration_retirements (reference_id TEXT PRIMARY KEY, reference TEXT NOT NULL)";
export const REGISTRATION_HISTORY_DAYS = 7;
type OutcomeInput = {
  version: 1;
  digest: string;
  issuedAt: string | null;
  createdAt: string | null;
};
type Rejection = "session-revoked" | "device-not-owned" | "preflight-failed";
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
  committed?: true;
  preparations?: TokenPreparation[];
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
  | {
      kind: "bind-token";
      deviceId: string;
      id: string;
      preparation: TokenPreparation;
      previous?: TokenPreparation;
      now: string;
    }
  | {
      kind: "authorize-token";
      deviceId: string;
      id: string;
      preparation: TokenPreparation;
      cleanup?: true;
      now: string;
    }
  | { kind: "retired"; deviceId: string; reference: TokenReference }
  | { kind: "finish"; deviceId: string; id: string }
  | { kind: "cancel"; deviceId: string; id: string }
  | { kind: "check" | "commit"; deviceId: string; id: string; now: string }
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
    canonicalJson({
      version: 1,
      digest: registrationDigest(intent.input),
      issuedAt: intent.now,
      createdAt: intent.now,
    } satisfies OutcomeInput),
    reason,
  );
export function prepareRegistrationStorage(storage: DurableObjectStorage) {
  if (storage.sql.exec<{ codec: number }>("SELECT codec FROM registration_retention").one().codec)
    return;
  storage.transactionSync(() => {
    for (const row of storage.sql
      .exec<{ operation_id: string; input: string }>(
        "SELECT operation_id, input FROM registration_outcomes",
      )
      .toArray()) {
      const input: unknown = JSON.parse(row.input);
      storage.sql.exec(
        "UPDATE registration_outcomes SET input = ? WHERE operation_id = ?",
        canonicalJson({
          version: 1,
          digest: registrationDigest(input),
          issuedAt: null,
          createdAt: null,
        } satisfies OutcomeInput),
        row.operation_id,
      );
    }
    for (const record of registrationRecords(storage)) {
      let changed = false;
      for (const candidate of [
        record.active,
        ...(record.pending?.candidate ? [record.pending.candidate] : []),
      ]) {
        if (candidate.device) {
          const {
            pushToken: _push,
            pushToStartToken: _start,
            ...registration
          } = candidate.device.registration;
          changed ||= _push !== undefined || _start !== undefined;
          candidate.device.registration = registration;
        }
      }
      if (changed) save(storage, record);
    }
    storage.sql.exec("UPDATE registration_retention SET codec = 1");
  });
}
export function pruneRegistrationOutcomes(storage: DurableObjectStorage, now: string) {
  const before = DateTime.formatIso(
    DateTime.subtract(DateTime.makeUnsafe(now), { days: REGISTRATION_HISTORY_DAYS }),
  );
  storage.transactionSync(() => {
    storage.sql.exec(
      "UPDATE registration_outcomes SET input = json_set(input, '$.createdAt', ?) WHERE json_extract(input, '$.createdAt') IS NULL",
      now,
    );
    storage.sql.exec("UPDATE registration_retention SET cutoff = max(cutoff, ?)", before);
    storage.sql.exec(
      "DELETE FROM registration_outcomes WHERE json_extract(input, '$.createdAt') < ?",
      before,
    );
  });
}
export const registrationRetirements = (storage: DurableObjectStorage) =>
  storage.sql
    .exec<{ reference: string }>(
      "SELECT reference FROM registration_retirements ORDER BY reference_id",
    )
    .toArray()
    .map((row) => JSON.parse(row.reference) as TokenReference);
function retireReferences(storage: DurableObjectStorage, references: TokenReference[]) {
  for (const reference of references)
    storage.sql.exec(
      "INSERT OR IGNORE INTO registration_retirements VALUES (?, ?)",
      tokenClaimDigest(reference),
      canonicalJson(reference),
    );
}
function historyReferences(
  storage: DurableObjectStorage,
  matches: (reference: TokenReference) => boolean,
) {
  return storage.sql
    .exec<{ reference: string }>("SELECT reference FROM registration_token_references")
    .toArray()
    .map((row) => JSON.parse(row.reference) as TokenReference)
    .filter(matches);
}
function deviceRetirements(storage: DurableObjectStorage, deviceId: string) {
  return registrationRetirements(storage).filter((reference) => reference.deviceId === deviceId);
}
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
        retirements: registrationRetirements(storage),
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
        const input = JSON.parse(previous.input) as OutcomeInput;
        if (
          input.digest !== registrationDigest(command.input) ||
          (input.issuedAt !== null && input.issuedAt !== command.now)
        )
          throw new Error("Registration operation intent mismatch");
        return previous.status === "completed"
          ? { completed: true }
          : { error: previous.reason ?? ("operation-cancelled" as const) };
      }
      if (record.pending) {
        if (
          record.pending.id === command.id &&
          (canonicalJson(record.pending.input) !== canonicalJson(command.input) ||
            record.pending.now !== command.now)
        )
          throw new Error("Registration operation intent mismatch");
        return { record };
      }
      const cutoff = storage.sql
        .exec<{ cutoff: string }>("SELECT cutoff FROM registration_retention")
        .one().cutoff;
      if (command.now <= cutoff) return { error: "operation-expired" } as const;
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
          preparations: [],
        };
        save(storage, record);
      }
      return { record };
    }
    switch (command.kind) {
      case "bind-token": {
        const pending = record.pending;
        if (pending?.id !== command.id || pending.candidate || pending.cancelling)
          return { bound: false } as const;
        const reason = validate(storage, pending.input, record.active, command.now);
        if (reason) {
          pending.cancelling = reason;
          save(storage, record);
          return { bound: false } as const;
        }
        const tickets = (pending.preparations ??= []);
        const index = tickets.findIndex(
          (ticket) => ticket.reference.operationId === command.preparation.reference.operationId,
        );
        if (index >= 0) {
          if (command.previous && canonicalJson(tickets[index]) === canonicalJson(command.previous))
            tickets[index] = command.preparation;
        } else tickets.push(command.preparation);
        save(storage, record);
        return { preparation: tickets[index >= 0 ? index : tickets.length - 1] };
      }
      case "authorize-token": {
        const pending = record.pending;
        const bound =
          pending?.id === command.id &&
          pending.preparations?.some(
            (ticket) => canonicalJson(ticket) === canonicalJson(command.preparation),
          );
        return {
          allowed:
            !!bound &&
            (command.cleanup ||
              (!pending?.cancelling &&
                !pending?.candidate &&
                validate(storage, pending.input, record.active, command.now) === null)),
        };
      }
      case "retired": {
        const reference = command.reference;
        if (reference.userId !== userId || reference.deviceId !== deviceId)
          throw new Error("Token cleanup owner mismatch");
        storage.sql.exec(
          "DELETE FROM registration_retirements WHERE reference_id = ?",
          tokenClaimDigest(reference),
        );
        const old = storage.sql
          .exec<{ reference: string }>(
            "SELECT reference FROM registration_token_references WHERE operation_id = ?",
            reference.operationId,
          )
          .toArray()[0];
        if (
          old &&
          tokenClaimDigest(JSON.parse(old.reference) as TokenReference) ===
            tokenClaimDigest(reference)
        )
          storage.sql.exec(
            "DELETE FROM registration_token_references WHERE operation_id = ?",
            reference.operationId,
          );
        return { applied: true };
      }
      case "check":
      case "commit": {
        const pending = record.pending;
        if (pending?.id !== command.id) {
          const previous = outcome(storage, command.id);
          return { status: previous?.status ?? "stale", reason: previous?.reason ?? null };
        }
        if (pending.committed) return { status: "committed" } as const;
        if (pending.cancelling) return { status: "cancel", reason: pending.cancelling } as const;
        const reason = validate(storage, pending.input, record.active, command.now);
        if (reason !== null) {
          pending.cancelling = reason;
          save(storage, record);
          return { status: "cancel", reason } as const;
        }
        if (command.kind === "commit" && !pending.candidate)
          return { status: "preparing" } as const;
        if (command.kind === "commit") {
          pending.committed = true;
          save(storage, record);
          return { status: "committed" } as const;
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
        if (record.pending?.id !== command.id || record.pending.cancelling)
          return { applied: false, record };
        if (record.pending.candidate) return { applied: true, record };
        const error = validate(storage, record.pending.input, record.active, command.now);
        if (error) {
          record.pending.cancelling = error;
          save(storage, record);
          return { applied: false };
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
          !record.pending.committed ||
          record.pending.cancelling
        )
          return { applied: false };
        retireReferences(
          storage,
          tokenReferences(record.active).filter(
            (old) =>
              !tokenReferences(record.pending!.candidate!).some(
                (next) => tokenClaimDigest(old) === tokenClaimDigest(next),
              ),
          ),
        );
        record.active = record.pending.candidate;
        settleOutcome(storage, record.pending, "completed");
        record.pending = null;
        save(storage, record);
        return { applied: true, retirements: deviceRetirements(storage, deviceId) };
      case "cancel":
        if (
          record.pending?.id === command.id &&
          !record.pending.committed &&
          !record.pending.candidate
        ) {
          record.pending.cancelling ??= "preflight-failed";
          save(storage, record);
        }
        return { record };
      case "remove":
        if (record.pending) return { busy: true };
        retireReferences(storage, [
          ...tokenReferences(record.active),
          ...historyReferences(storage, (reference) => reference.deviceId === deviceId),
        ]);
        storage.sql.exec("DELETE FROM account_registrations WHERE device_id = ?", deviceId);
        return { applied: true, retirements: deviceRetirements(storage, deviceId) };
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
        if (!command.keepToken && old?.token) retireReferences(storage, [old.token]);
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
        return { applied: true, retirements: deviceRetirements(storage, deviceId) };
      }
      case "invalidate": {
        if (record.pending) return { busy: true };
        if (command.push) {
          if (
            record.active.device &&
            (command.token === undefined || record.active.device.push?.token === command.token)
          ) {
            if (record.active.device.push) retireReferences(storage, [record.active.device.push]);
            record.active.device.push = null;
            if (command.now) record.active.device.updatedAt = command.now;
          }
        } else if (record.active.activity) {
          if (record.active.activity.token)
            retireReferences(storage, [record.active.activity.token]);
          record.active.activity.token = null;
          record.active.activity.remoteStartQueuedAt = null;
          record.active.activity.remoteStartedAt = null;
          record.active.activity.endedAt = command.now ?? record.active.activity.endedAt;
          if (command.now) record.active.activity.updatedAt = command.now;
        }
        if (records.some((row) => row.deviceId === deviceId)) save(storage, record);
        return { applied: true, retirements: deviceRetirements(storage, deviceId) };
      }
    }
  });
}

export function registrationRemoval(storage: DurableObjectStorage, command: IdentityCommand) {
  const sessions = storage.sql
    .exec<{ value: string }>("SELECT value FROM account_sessions")
    .toArray()
    .map((row) => JSON.parse(row.value) as StoredSession);
  const retirements = registrationRetirements(storage);
  const sessionIds = sessions
    .filter((session) => {
      if (command.kind === "prune-sessions") return session.expiresAt <= command.now;
      if (command.kind === "revoke-session")
        return (
          session.sessionId === command.sessionId &&
          (!session.revoked ||
            retirements.some((reference) => reference.sessionId === session.sessionId))
        );
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
    retirements:
      command.kind === "prune-sessions"
        ? retirements
        : retirements.filter((reference) => sessionIds.includes(reference.sessionId ?? "")),
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
  retireReferences(
    storage,
    historyReferences(storage, (reference) => sessionIds.includes(reference.sessionId ?? "")),
  );
  for (const record of removalRecords(storage, sessionIds)) {
    if (sessionIds.includes(record.active.device?.sessionId ?? "")) {
      retireReferences(storage, tokenReferences(record.active));
      record.active = { device: null, activity: null };
    }
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
    summarize("registration_retirements", registrationRetirements(storage)),
    summarize("registration_retention", storage.sql.exec("SELECT * FROM registration_retention")),
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
