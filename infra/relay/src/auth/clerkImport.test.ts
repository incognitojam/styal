import { describe, expect, it } from "@effect/vitest";

import { type ClerkUser, clerkUserEmail } from "./clerkImport.ts";

const user = (overrides: Partial<ClerkUser>): ClerkUser => ({
  id: "user_1",
  primary_email_address_id: "email_primary",
  email_addresses: [],
  ...overrides,
});

describe("clerkUserEmail", () => {
  it("uses the verified primary address, lowercased", () => {
    expect(
      clerkUserEmail(
        user({
          email_addresses: [
            {
              id: "email_other",
              email_address: "other@example.com",
              verification: { status: "verified" },
            },
            {
              id: "email_primary",
              email_address: "Main@Example.com",
              verification: { status: "verified" },
            },
          ],
        }),
      ),
    ).toBe("main@example.com");
  });

  it("falls back to another verified address when the primary is unverified", () => {
    expect(
      clerkUserEmail(
        user({
          email_addresses: [
            {
              id: "email_primary",
              email_address: "new@example.com",
              verification: { status: "unverified" },
            },
            {
              id: "email_old",
              email_address: "old@example.com",
              verification: { status: "verified" },
            },
          ],
        }),
      ),
    ).toBe("old@example.com");
  });

  it("returns null without a verified address", () => {
    expect(
      clerkUserEmail(
        user({
          email_addresses: [
            { id: "email_primary", email_address: "a@example.com", verification: null },
          ],
        }),
      ),
    ).toBeNull();
  });
});
