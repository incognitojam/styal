import type { IdentityBindings } from "./IdentityCoordinator.ts";
import type { PushTokenObject, TokenReference, TokenKind } from "./PushTokenObject.ts";
import type { TokenPreparation } from "./TokenProtocol.ts";
import { TokenCoordinator } from "./TokenCoordinator.ts";
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

export class RegistrationCoordinator {
  readonly bindings: RegistrationBindings;
  readonly tokens: TokenCoordinator;
  constructor(bindings: RegistrationBindings) {
    this.bindings = bindings;
    this.tokens = new TokenCoordinator(bindings);
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
  async resolve(candidate: RegistrationCandidate): Promise<RegistrationCandidate> {
    const next = structuredClone(candidate);
    const status = async (reference: TokenReference | null | undefined) => {
      if (!reference) return null;
      return this.token(reference).status({ version, reference });
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
    return {
      records: result.records,
      liveSessionIds: result.liveSessionIds ?? [],
      retirements: result.retirements ?? [],
    };
  }
  async views(userId: string, now: string, includeExpired = false) {
    const snapshot = await this.snapshot(userId, now);
    const views: Array<{ deviceId: string; candidate: RegistrationCandidate }> = [];
    for (const record of snapshot.records) {
      let view: RegistrationCandidate = { device: null, activity: null };
      for (const candidate of [
        record.active,
        ...(record.pending?.candidate && record.pending.committed && !record.pending.cancelling
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
        if ("completed" in result && result.completed) {
          await this.recoverRetirements(userId, deviceId, now);
          return;
        }
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

  async drain(userId: string, references: TokenReference[], now: string) {
    for (const reference of references) {
      await this.tokens.release(reference, now);
      await this.command(userId, { kind: "retired", deviceId: reference.deviceId, reference });
    }
  }
  private async recoverRetirements(userId: string, deviceId: string, now: string) {
    await this.drain(
      userId,
      (await this.snapshot(userId, now)).retirements.filter(
        (reference) => reference.deviceId === deviceId,
      ),
      now,
    );
  }
  private async cancelIntent(
    userId: string,
    record: RegistrationRecord,
    pending: RegistrationIntent,
    now: string,
  ) {
    for (const preparation of pending.preparations ??
      pending.claims.map((claim) => ({
        ...claim,
        initialization: null,
        epoch: null,
        admittedAt: pending.now,
      }))) {
      await this.tokens.release(preparation.reference, now, preparation.initialization);
      await this.command(userId, {
        kind: "retired",
        deviceId: record.deviceId,
        reference: preparation.reference,
      });
    }
    await this.command(userId, { kind: "abort", deviceId: record.deviceId, id: pending.id });
  }
  private rejected(reason: RegistrationIntent["cancelling"], cause?: unknown): never {
    if (reason === "device-not-owned") throw new DeviceNotOwnedBySession({});
    if (reason === "session-revoked") throw new DeviceSessionRevoked({});
    throw cause ?? new Error("Registration operation was cancelled");
  }
  async resume(userId: string, record: RegistrationRecord, now: string) {
    let intent = record.pending;
    if (!intent) return;
    const commit = async (pending: RegistrationIntent) => {
      const current = await this.command(userId, {
        kind: "commit",
        deviceId: record.deviceId,
        id: pending.id,
        now,
      });
      if ("status" in current && current.status === "completed") {
        await this.recoverRetirements(userId, record.deviceId, now);
        return "completed" as const;
      }
      if ("status" in current && current.status === "committed") return "ready" as const;
      if ("status" in current && current.status === "cancel") {
        const cancelled = await this.command(userId, {
          kind: "cancel",
          deviceId: record.deviceId,
          id: pending.id,
        });
        if ("record" in cancelled && cancelled.record?.pending?.id === pending.id)
          await this.cancelIntent(userId, cancelled.record, cancelled.record.pending, now);
      }
      if ("status" in current && (current.status === "cancel" || current.status === "cancelled"))
        this.rejected(current.reason ?? undefined);
      throw new Error("Registration operation changed");
    };
    if (intent.cancelling) {
      await this.cancelIntent(userId, record, intent, now);
      this.rejected(intent.cancelling);
    }
    if (!intent.candidate) {
      let prepared:
        | { candidate: RegistrationCandidate; claims: RegistrationIntent["claims"] }
        | undefined;
      try {
        prepared = await this.prepare(userId, record, intent, now);
      } catch (error) {
        const cancelled = await this.command(userId, {
          kind: "cancel",
          deviceId: record.deviceId,
          id: intent.id,
        });
        if ("record" in cancelled && cancelled.record?.pending?.id === intent.id) {
          const pending = cancelled.record.pending;
          if (pending.candidate && !pending.cancelling) intent = pending;
          else {
            await this.cancelIntent(userId, cancelled.record, pending, now);
            this.rejected(pending.cancelling, error);
          }
        } else {
          const previous = await this.command(userId, {
            kind: "check",
            deviceId: record.deviceId,
            id: intent.id,
            now,
          });
          if ("status" in previous && previous.status === "completed") {
            await this.recoverRetirements(userId, record.deviceId, now);
            return;
          }
          throw error;
        }
      }
      if (prepared) {
        const ready = await this.command(userId, {
          kind: "ready",
          deviceId: record.deviceId,
          id: intent.id,
          ...prepared,
          now,
        });
        if (!("record" in ready) || !ready.record?.pending) {
          if ((await commit(intent)) === "completed") return;
          throw new Error("Registration readiness changed");
        }
        intent = ready.record.pending;
      }
    }
    if ((await commit(intent)) === "completed") return;
    for (const claim of intent.claims) {
      const result = await this.token(claim.reference).transfer({
        version,
        ...claim,
        now: intent.now,
      });
      if (!("applied" in result)) throw new Error("Push token transfer is not ready");
    }
    const finished = await this.command(userId, {
      kind: "finish",
      deviceId: record.deviceId,
      id: intent.id,
    });
    if (!("applied" in finished) || !finished.applied) {
      if ((await commit(intent)) !== "completed")
        throw new Error("Registration completion changed");
    } else if ("retirements" in finished && finished.retirements)
      await this.drain(userId, finished.retirements, now);
  }
  private async settleRecord(userId: string, record: RegistrationRecord, now: string) {
    if (!record.pending) return;
    try {
      await this.resume(userId, record, now);
    } catch (error) {
      const terminal = await this.command(userId, {
        kind: "check",
        deviceId: record.deviceId,
        id: record.pending.id,
        now,
      });
      if (
        "status" in terminal &&
        (terminal.status === "completed" || terminal.status === "cancelled")
      )
        return;
      throw error;
    }
  }
  async settle(userId: string, deviceId: string, now: string) {
    await this.gate(userId, deviceId, async () => {
      const record = (await this.snapshot(userId, now)).records.find(
        (row) => row.deviceId === deviceId,
      );
      if (record) await this.settleRecord(userId, record, now);
    });
  }
  private async prepare(
    userId: string,
    record: RegistrationRecord,
    intent: RegistrationIntent,
    now: string,
  ) {
    const old = await this.resolve(record.active);
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
      let previousTicket: TokenPreparation | undefined;
      for (let retry = 0; retry < 3; retry++) {
        const state = await this.token({ kind, token }).read({ version });
        if (state.retirement) {
          await this.tokens.finishRetirement(
            {
              kind,
              token,
              userId,
              deviceId: record.deviceId,
              sessionId,
              operationId: intent.id + ":" + kind,
              generation: state.generation + 1,
              incarnation: state.incarnation,
            },
            state.retirement,
          );
          continue;
        }
        const proposed: TokenPreparation = {
          reference: {
            kind,
            token,
            userId,
            deviceId: record.deviceId,
            sessionId,
            operationId: intent.id + ":" + kind,
            generation: state.generation + 1,
            incarnation: state.incarnation,
          },
          expected: state.generation,
          initialization: state.initialization,
          epoch: state.epoch,
          admittedAt: now,
        };
        let bound = await this.command(userId, {
          kind: "bind-token",
          deviceId: record.deviceId,
          id: intent.id,
          preparation: proposed,
          ...(previousTicket ? { previous: previousTicket } : {}),
          now,
        });
        if (!("preparation" in bound) || !bound.preparation)
          throw new Error("Token preparation binding changed");
        let ticket = bound.preparation;
        if (ticket.epoch === null || ticket.epoch === 0) {
          const allocated = await this.tokens.ticket(ticket);
          if (!allocated) {
            await this.tokens.release(ticket.reference, now, ticket.initialization);
            previousTicket = ticket;
            continue;
          }
          bound = await this.command(userId, {
            kind: "bind-token",
            deviceId: record.deviceId,
            id: intent.id,
            preparation: allocated,
            previous: ticket,
            now,
          });
          if (!("preparation" in bound) || !bound.preparation)
            throw new Error("Token epoch binding changed");
          ticket = bound.preparation;
        }
        const authorized = await this.command(userId, {
          kind: "authorize-token",
          deviceId: record.deviceId,
          id: intent.id,
          preparation: ticket,
          now,
        });
        if (!("allowed" in authorized) || !authorized.allowed)
          throw new Error("Token preparation authorization changed");
        const prepared = await this.token(ticket.reference).prepare({
          version,
          preparation: ticket,
        });
        if (prepared.state === "retiring") {
          await this.tokens.finishRetirement(ticket.reference, prepared.retirement);
          previousTicket = ticket;
          continue;
        }
        if (prepared.state === "stale") {
          await this.tokens.release(ticket.reference, now, ticket.initialization);
          previousTicket = ticket;
          continue;
        }
        if (prepared.state === "rejected") throw new Error("Token preparation was cancelled");
        if (
          !state.published ||
          state.incarnation !== ticket.reference.incarnation ||
          state.epoch !== ticket.epoch
        ) {
          const publication = await this.command(userId, {
            kind: "authorize-token",
            deviceId: record.deviceId,
            id: intent.id,
            preparation: ticket,
            now,
          });
          if (
            !("allowed" in publication) ||
            !publication.allowed ||
            ticket.epoch === null ||
            !(await this.tokens.publish(ticket.reference, ticket.epoch))
          )
            throw new Error("Token publication authorization changed");
        }
        claims.push({ reference: ticket.reference, expected: ticket.expected });
        return ticket.reference;
      }
      throw new Error("Token preparation repeatedly changed");
    };
    if (intent.input.kind === "device") {
      const registration = intent.input.registration;
      const { pushToken: _push, pushToStartToken: _start, ...metadata } = registration;
      const sessionId = intent.input.sessionId ?? null;
      candidate.device = {
        registration: {
          ...metadata,
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
      if (record) await this.settleRecord(userId, record, now);
      let result = await this.command(userId, command);
      if ("needsRegistration" in result && command.kind === "mark") {
        await this.registerReference("account", accountName(userId));
        result = await this.command(userId, { ...command, registered: true });
      }
      if ("busy" in result) throw new Error("Concurrent registration mutation");
      if ("retirements" in result && result.retirements)
        await this.drain(userId, result.retirements, now);
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
          ...(record.pending?.candidate && record.pending.committed && !record.pending.cancelling
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
