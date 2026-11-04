import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import {
  makeApnsDeliveryJobPayload,
  signApnsDeliveryJob,
  verifySignedApnsDeliveryJob,
} from "./apnsDeliveryJobs.ts";

const secret = Redacted.make("queue-signing-secret");

describe("apnsDeliveryJobs", () => {
  it.effect("authenticates the registration-removal authorization in the signature", () =>
    Effect.gen(function* () {
      const payload = makeApnsDeliveryJobPayload({
        kind: "live_activity_end",
        userId: "usr_synthetic",
        deviceId: "phone",
        token: "card-token",
        aggregate: null,
        createdAt: "2026-05-25T00:00:00.000Z",
        expiresAt: "2026-05-25T00:05:00.000Z",
        jobId: "job-removal",
      });
      const signed = yield* signApnsDeliveryJob({ secret, payload });
      const result = yield* Effect.flip(
        verifySignedApnsDeliveryJob({
          secret,
          nowMs: Date.parse("2026-05-25T00:01:00.000Z"),
          job: { ...signed, payload: { ...signed.payload, registrationRemoved: true } },
        }),
      );
      expect(result).toMatchObject({ _tag: "ApnsDeliveryJobSignatureInvalid" });
    }).pipe(Effect.provide(NodeCryptoLayer.layerMac)),
  );

  it.effect("rejects tampered signed queue jobs", () =>
    Effect.gen(function* () {
      const payload = makeApnsDeliveryJobPayload({
        kind: "live_activity_end",
        userId: "user-1",
        deviceId: "device-1",
        token: "token-1",
        aggregate: null,
        createdAt: "2026-05-25T00:00:00.000Z",
        expiresAt: "2026-05-25T00:05:00.000Z",
        jobId: "job-1",
      });
      const signed = yield* signApnsDeliveryJob({ secret, payload });
      expect(yield* verifySignedApnsDeliveryJob({ secret, job: signed, nowMs: 0 })).toEqual(
        payload,
      );
      const tampered = {
        ...signed,
        payload: {
          ...signed.payload,
          target: {
            ...signed.payload.target,
            token: "attacker-token",
          },
        },
      };

      const result = yield* Effect.flip(
        verifySignedApnsDeliveryJob({
          secret,
          job: tampered,
          nowMs: 0,
        }),
      );

      expect(result).toMatchObject({
        _tag: "ApnsDeliveryJobSignatureInvalid",
        jobId: "job-1",
        kind: "live_activity_end",
        userId: "user-1",
        deviceId: "device-1",
        message: "Invalid signature for APNs delivery job job-1.",
      });
    }).pipe(Effect.provide(NodeCryptoLayer.layerMac)),
  );
});
