import * as Schema from "effect/Schema";
import type { IdentityBindings } from "./IdentityCoordinator.ts";
import type { PushTokenObject, TokenReference, TokenKind } from "./PushTokenObject.ts";
import type {
  RegistrationCandidate,
  RegistrationCommand,
  RegistrationInput,
  RegistrationIntent,
  RegistrationRecord,
} from "./AccountRegistrations.ts";
import { tokenReferences } from "./AccountRegistrations.ts";
import { DeviceSessionRevoked, DeviceNotOwnedBySession } from "../agentActivity/Devices.ts";
import {
  accountName,
  pushTokenName,
  inventoryShardName,
  inventoryShardNames,
  credentialRouteName,
} from "./names.ts";
import { RPC_VERSION as version } from "./storage.ts";
import type { RegistrationCleanupScope } from "../persistence/DeliveryTargetPersistence.ts";

export interface RegistrationBindings extends Pick<
  IdentityBindings,
  "ACCOUNTS" | "INVENTORY" | "CREDENTIAL_ROUTES"
> {
  PUSH_TOKENS: Pick<DurableObjectNamespace<PushTokenObject>, "getByName">;
}
const isSessionRevoked = Schema.is(DeviceSessionRevoked);

export class RegistrationCoordinator {
  readonly bindings: RegistrationBindings;
  constructor(bindings: RegistrationBindings) {
    this.bindings = bindings;
  }
  private async gate(userId: string, deviceId: string, callback: () => Promise<void>) {
    let failure: unknown;
    try {
      await this.account(userId).registrationGate({ version, userId, deviceId }, async () => {
        try {
          await callback();
        } catch (error) {
          failure = error;
        }
      });
      if (failure !== undefined) throw failure;
    } catch (error) {
      throw failure ?? error;
    }
  }
  account(userId: string) {
    return this.bindings.ACCOUNTS.getByName(accountName(userId));
  }
  token(reference: Pick<TokenReference, "kind" | "token">) {
    return this.bindings.PUSH_TOKENS.getByName(pushTokenName(reference.kind, reference.token));
  }
  async command(userId: string, command: RegistrationCommand) {
    const result = await this.account(userId).registrations({ version, userId, command });
    if ("error" in result) {
      if (result.error === "session-revoked") throw new DeviceSessionRevoked({});
      if (result.error === "device-not-owned") throw new DeviceNotOwnedBySession({});
      throw new Error("Registration operation was cancelled");
    }
    return result;
  }
  async registerReference(kind: "account" | "push-token", name: string) {
    await this.bindings.INVENTORY.getByName(inventoryShardName(kind, name)).register({
      version,
      references: [{ kind, name }],
    });
  }
  async resolve(candidate: RegistrationCandidate, strict = false): Promise<RegistrationCandidate> {
    const next = structuredClone(candidate);
    const status = async (reference: TokenReference | null | undefined) => {
      if (!reference) return null;
      try {
        return await this.token(reference).status({ version, reference });
      } catch (error) {
        if (strict) throw error;
        return { live: false, lostAt: null };
      }
    };
    const [push, start, activity] = await Promise.all([
      status(next.device?.push),
      status(next.device?.start),
      status(next.activity?.token),
    ]);
    if (next.device) {
      if (!push?.live) next.device.push = null;
      if (!start?.live) next.device.start = null;
      for (const loss of [push?.lostAt, start?.lostAt])
        if (loss && loss > next.device.updatedAt) next.device.updatedAt = loss;
    }
    if (next.activity && next.activity.token && !activity?.live) {
      next.activity.token = null;
      if (activity?.lostAt) {
        next.activity.remoteStartQueuedAt = null;
        next.activity.remoteStartedAt = null;
        next.activity.endedAt = activity.lostAt;
        next.activity.updatedAt = activity.lostAt;
      }
    }
    return next;
  }
  async snapshot(userId: string, now: string) {
    const result = await this.command(userId, { kind: "read", now });
    if (!("records" in result) || !result.records || !("liveSessionIds" in result))
      throw new Error("Missing registration snapshot");
    return { records: result.records, liveSessionIds: result.liveSessionIds ?? [] };
  }
  async views(userId: string, now: string, includeExpired = false) {
    const snapshot = await this.snapshot(userId, now);
    const views: Array<{ deviceId: string; candidate: RegistrationCandidate }> = [];
    for (const record of snapshot.records) {
      let view: RegistrationCandidate = { device: null, activity: null };
      for (const candidate of [
        record.active,
        ...(record.pending?.candidate && !record.pending.cancelling
          ? [record.pending.candidate]
          : []),
      ]) {
        if (
          candidate.device &&
          candidate.device.sessionId !== null &&
          !includeExpired &&
          !snapshot.liveSessionIds.includes(candidate.device.sessionId)
        )
          continue;
        const resolved = await this.resolve(candidate);
        const owned = new Set(tokenReferences(resolved).map((reference) => reference.operationId));
        if (
          candidate === record.active ||
          (!view.device && !view.activity) ||
          !record.pending?.claims.length ||
          record.pending.claims.some((claim) => owned.has(claim.reference.operationId))
        )
          view = resolved;
      }
      views.push({ deviceId: record.deviceId, candidate: view });
    }
    return views;
  }
  async register(userId: string, input: RegistrationInput, id: string, now: string) {
    const deviceId = input.registration.deviceId;
    await this.gate(userId, deviceId, async () => {
      for (let predecessor = 0; predecessor < 2; predecessor++) {
        let result = await this.command(userId, { kind: "begin", input, id, now });
        if ("needsRegistration" in result) {
          await this.registerReference("account", accountName(userId));
          result = await this.command(userId, { kind: "begin", input, id, now, registered: true });
        }
        if ("completed" in result && result.completed) return;
        if (!("record" in result) || !result.record?.pending)
          throw new Error("Registration intent unavailable");
        const pending = result.record.pending;
        try {
          await this.resume(userId, result.record, now);
        } catch (error) {
          const terminal = await this.command(userId, {
            kind: "check",
            deviceId,
            id: pending.id,
            now,
          });
          if (!("status" in terminal) || terminal.status !== "cancelled" || pending.id === id)
            throw error;
          continue;
        }
        if (pending.id === id) return;
      }
      throw new Error("Concurrent registration changed");
    });
  }

  async resume(userId: string, record: RegistrationRecord, now: string) {
    let intent = record.pending;
    if (!intent) return;
    const check = async (pending: RegistrationIntent) => {
      const current = await this.command(userId, {
        kind: "check",
        deviceId: record.deviceId,
        id: pending.id,
        now,
      });
      if ("status" in current && current.status === "completed") return "completed" as const;
      if ("status" in current && current.status === "ready") return "ready" as const;
      if ("status" in current && current.status === "cancel") {
        for (const claim of pending.claims)
          await this.token(claim.reference).fence({ version, ...claim, now, registered: true });
        await this.command(userId, { kind: "abort", deviceId: record.deviceId, id: pending.id });
      }
      if ("status" in current && (current.status === "cancel" || current.status === "cancelled")) {
        if (current.reason === "device-not-owned") throw new DeviceNotOwnedBySession({});
        if (current.reason === "session-revoked") throw new DeviceSessionRevoked({});
        throw new Error("Registration operation was cancelled");
      }
      throw new Error("Registration operation changed");
    };
    if (!intent.candidate) {
      let prepared: { candidate: RegistrationCandidate; claims: RegistrationIntent["claims"] };
      try {
        prepared = await this.prepare(userId, record, intent);
      } catch (error) {
        await this.command(userId, { kind: "cancel", deviceId: record.deviceId, id: intent.id });
        throw error;
      }
      const ready = await this.command(userId, {
        kind: "ready",
        deviceId: record.deviceId,
        id: intent.id,
        ...prepared,
        now,
      });
      if (!("record" in ready) || !ready.record?.pending) {
        if ((await check(intent)) === "completed") return;
        throw new Error("Registration readiness changed");
      }
      intent = ready.record.pending;
    }
    if ((await check(intent)) === "completed") return;
    for (const claim of intent.claims) {
      const result = await this.token(claim.reference).transfer({
        version,
        ...claim,
        now: intent.now,
        registered: true,
      });
      if ("needsRegistration" in result) throw new Error("Push token initialization changed");
    }
    const finished = await this.command(userId, {
      kind: "finish",
      deviceId: record.deviceId,
      id: intent.id,
    });
    if (!("applied" in finished) || !finished.applied) {
      if ((await check(intent)) !== "completed") throw new Error("Registration completion changed");
    }
  }
  async settle(userId: string, deviceId: string, now: string) {
    await this.gate(userId, deviceId, async () => {
      const record = (await this.snapshot(userId, now)).records.find(
        (row) => row.deviceId === deviceId,
      );
      if (!record?.pending) return;
      try {
        await this.resume(userId, record, now);
      } catch (error) {
        if (
          isSessionRevoked(error) &&
          !(await this.snapshot(userId, now)).records.find((row) => row.deviceId === deviceId)
            ?.pending
        )
          return;
        throw error;
      }
    });
  }
  private async prepare(userId: string, record: RegistrationRecord, intent: RegistrationIntent) {
    const old = await this.resolve(record.active, true);
    const candidate = structuredClone(old);
    const claims: RegistrationIntent["claims"] = [];
    const claim = async (
      kind: TokenKind,
      token: string | undefined,
      previous: TokenReference | null,
      sessionId: string | null,
    ) => {
      if (!token) return previous;
      if (previous?.token === token && previous.sessionId === sessionId) return previous;
      const state = await this.token({ kind, token }).read({ version });
      if (!state.initialized)
        await this.registerReference("push-token", pushTokenName(kind, token));
      const reference: TokenReference = {
        kind,
        token,
        userId,
        deviceId: record.deviceId,
        sessionId,
        operationId: `${intent.id}:${kind}`,
        generation: state.generation + 1,
      };
      claims.push({ reference, expected: state.generation });
      return reference;
    };
    if (intent.input.kind === "device") {
      const registration = intent.input.registration;
      const sessionId = intent.input.sessionId ?? null;
      candidate.device = {
        registration: {
          ...registration,
          bundleId: registration.bundleId ?? old.device?.registration.bundleId,
          apsEnvironment: registration.apsEnvironment ?? old.device?.registration.apsEnvironment,
        },
        sessionId,
        push: await claim(
          "push",
          registration.pushToken ?? old.device?.push?.token,
          old.device?.push ?? null,
          sessionId,
        ),
        start: await claim(
          "push-to-start",
          registration.pushToStartToken ?? old.device?.start?.token,
          old.device?.start ?? null,
          sessionId,
        ),
        createdAt: old.device?.createdAt ?? intent.now,
        updatedAt: intent.now,
      };
      if (old.device && old.device.sessionId !== sessionId) candidate.activity = null;
    } else {
      const token = intent.input.registration.activityPushToken;
      candidate.activity = {
        createdAt: old.activity?.createdAt ?? intent.now,
        remoteStartQueuedAt: null,
        token: await claim(
          "live-activity",
          token,
          old.activity?.token ?? null,
          old.device?.sessionId ?? null,
        ),
        remoteStartedAt:
          old.activity?.token?.token === token
            ? (old.activity.remoteStartedAt ?? intent.now)
            : intent.now,
        endedAt: null,
        aggregate: null,
        deliveredAt: null,
        updatedAt: intent.now,
      };
    }
    return { candidate, claims };
  }
  async mutate(userId: string, deviceId: string, command: RegistrationCommand, now: string) {
    await this.gate(userId, deviceId, async () => {
      const record = (await this.snapshot(userId, now)).records.find(
        (row) => row.deviceId === deviceId,
      );
      if (record?.pending) await this.resume(userId, record, now);
      let result = await this.command(userId, command);
      if ("needsRegistration" in result && command.kind === "mark") {
        await this.registerReference("account", accountName(userId));
        result = await this.command(userId, { ...command, registered: true });
      }
      if ("busy" in result) throw new Error("Concurrent registration mutation");
    });
  }
  async accountIds() {
    const ids: string[] = [];
    // Maintenance only; request paths route to an account or immutable session route.
    for (const shard of inventoryShardNames) {
      let after = "";
      for (;;) {
        const refs = await this.bindings.INVENTORY.getByName(shard).list({
          version,
          kind: "account",
          after,
          limit: 1000,
        });
        for (const ref of refs) {
          const userId = await this.bindings.ACCOUNTS.getByName(ref.name).identityOwner({
            version,
          });
          if (userId) ids.push(userId);
        }
        if (refs.length < 1000) break;
        after = refs[refs.length - 1]!.name;
      }
    }
    return ids;
  }
  async cleanup(scope: RegistrationCleanupScope, now: string) {
    const users =
      scope.kind === "sessions"
        ? [
            ...new Set(
              (
                await Promise.all(
                  scope.sessionIds.map((id) =>
                    this.bindings.CREDENTIAL_ROUTES.getByName(
                      credentialRouteName("session", id),
                    ).resolve({ version }),
                  ),
                )
              ).filter((id): id is string => !!id),
            ),
          ]
        : [scope.userId];
    const targets = [];
    const seen = new Set<string>();
    for (const userId of users)
      for (const record of (await this.snapshot(userId, now)).records)
        for (const candidate of [
          record.active,
          ...(record.pending?.candidate && !record.pending.cancelling
            ? [record.pending.candidate]
            : []),
        ]) {
          const device = candidate.device;
          const reference = candidate.activity?.token;
          if (!device || !reference || seen.has(reference.operationId)) continue;
          if (scope.kind === "session" && device.sessionId !== scope.sessionId) continue;
          if (scope.kind === "sessions" && !scope.sessionIds.includes(device.sessionId ?? ""))
            continue;
          if (!(await this.token(reference).status({ version, reference })).live) continue;
          seen.add(reference.operationId);
          targets.push({
            userId,
            deviceId: record.deviceId,
            token: reference.token,
            bundleId: device.registration.bundleId ?? null,
            apsEnvironment: device.registration.apsEnvironment ?? null,
          });
        }
    return targets;
  }
}
