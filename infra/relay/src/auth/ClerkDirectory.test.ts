import { createClerkClient } from "@clerk/backend";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { vi } from "vite-plus/test";

import * as RelayConfiguration from "../Config.ts";
import { config as relayConfig } from "../test/fixtures.ts";
import * as ClerkDirectory from "./ClerkDirectory.ts";

vi.mock("@clerk/backend", () => ({ createClerkClient: vi.fn() }));
const config = { clerkSecretKey: Redacted.make("secret"), clerkPublishableKey: "pk_test_test" };
const address = (id: string, emailAddress: string, status = "verified") => ({
  id,
  emailAddress,
  verification: { status },
});
const user = {
  id: "user_found",
  primaryEmailAddressId: "primary",
  emailAddresses: [
    address("unverified", "unverified@example.com", "unverified"),
    address("secondary", "Secondary@Example.com"),
    address("primary", "PRIMARY@example.com"),
  ],
};
const mockClient = (users: unknown) =>
  vi.mocked(createClerkClient).mockReturnValue({ users } as ReturnType<typeof createClerkClient>);

describe("ClerkDirectory", () => {
  it.effect("returns only verified addresses, normalized, preferring the verified primary", () => {
    mockClient({ getUser: async () => user });
    return Effect.gen(function* () {
      expect(yield* ClerkDirectory.make(config).verifiedEmails("user_found")).toEqual(
        Option.some({
          primary: "primary@example.com",
          all: ["secondary@example.com", "primary@example.com"],
        }),
      );
    });
  });

  it.effect("a user with no verified addresses remains Some with a null primary", () => {
    mockClient({
      getUser: async () => ({
        ...user,
        emailAddresses: [address("primary", "primary@example.com", "unverified")],
      }),
    });
    return Effect.gen(function* () {
      expect(yield* ClerkDirectory.make(config).verifiedEmails("user_found")).toEqual(
        Option.some({ primary: null, all: [] }),
      );
    });
  });

  it.effect("uses a verified fallback when the primary is unverified", () => {
    mockClient({ getUser: async () => ({ ...user, primaryEmailAddressId: "unverified" }) });
    return Effect.gen(function* () {
      const result = yield* ClerkDirectory.make(config).verifiedEmails("user_found");
      expect(Option.getOrThrow(result).primary).toBe("secondary@example.com");
    });
  });

  it.effect("returns None only for a confirmed missing user", () => {
    mockClient({
      getUser: async () => {
        throw { status: 404 };
      },
    });
    return Effect.gen(function* () {
      expect(yield* ClerkDirectory.make(config).verifiedEmails("user_deleted")).toEqual(
        Option.none(),
      );
    });
  });

  it.effect.each([new TypeError("fetch failed"), { status: 503 }, { status: 401 }])(
    "directory failures remain typed (%j)",
    (failure) => {
      const fail = async () => {
        throw failure;
      };
      mockClient({ getUser: fail, getUserList: fail });
      return Effect.gen(function* () {
        const directory = ClerkDirectory.make(config);
        expect((yield* Effect.flip(directory.verifiedEmails("user_found")))._tag).toBe(
          "ClerkDirectoryUnavailable",
        );
        expect((yield* Effect.flip(directory.userIdForEmail("primary@example.com")))._tag).toBe(
          "ClerkDirectoryUnavailable",
        );
      });
    },
  );

  it.effect("resolves verified secondary addresses to the Clerk id", () => {
    const getUserList = vi.fn(async () => ({ data: [user], totalCount: 1 }));
    mockClient({ getUserList });
    return Effect.gen(function* () {
      expect(yield* ClerkDirectory.make(config).userIdForEmail(" Secondary@Example.COM ")).toEqual(
        Option.some("user_found"),
      );
      expect(getUserList).toHaveBeenCalledWith({
        emailAddress: ["secondary@example.com"],
        limit: 100,
        offset: 0,
      });
    });
  });

  it.effect("ignores unverified matches and pages until a verified exact match", () => {
    const getUserList = vi.fn(async ({ offset }: { offset: number }) =>
      offset === 0
        ? {
            data: [
              { ...user, emailAddresses: [address("x", "primary@example.com", "unverified")] },
            ],
            totalCount: 2,
          }
        : { data: [user], totalCount: 2 },
    );
    mockClient({ getUserList });
    return Effect.gen(function* () {
      expect(yield* ClerkDirectory.make(config).userIdForEmail("primary@example.com")).toEqual(
        Option.some("user_found"),
      );
      expect(getUserList).toHaveBeenCalledTimes(2);
    });
  });

  it.effect("unverified and unknown addresses do not resolve to a Clerk identity", () => {
    mockClient({ getUserList: async () => ({ data: [user], totalCount: 1 }) });
    return Effect.gen(function* () {
      expect(yield* ClerkDirectory.make(config).userIdForEmail("unverified@example.com")).toEqual(
        Option.none(),
      );
      expect(yield* ClerkDirectory.make(config).userIdForEmail("unknown@example.com")).toEqual(
        Option.none(),
      );
    });
  });
});

describe("ClerkDirectory.layer", () => {
  it.effect("does not call Clerk when the relay has no Clerk secret", () =>
    Effect.gen(function* () {
      vi.mocked(createClerkClient).mockClear();
      const directory = yield* ClerkDirectory.ClerkDirectory;
      expect(directory.configured).toBe(false);
      expect(yield* directory.userIdForEmail("someone@example.com")).toEqual(Option.none());
      expect(yield* directory.verifiedEmails("user_1")).toEqual(Option.none());
      expect(createClerkClient).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        ClerkDirectory.layer.pipe(
          Layer.provide(
            RelayConfiguration.layer({ ...relayConfig, clerkSecretKey: Redacted.make("") }),
          ),
        ),
      ),
    ),
  );
});
