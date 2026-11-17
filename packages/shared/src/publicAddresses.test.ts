import { expect, it } from "@effect/vitest";
import { publicAddresses } from "./publicAddresses.ts";

it.each([
  "127.0.0.1",
  "10.2.3.4",
  "169.254.169.254",
  "100.64.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "fc00::1",
  "fe80::1",
  "64:ff9b::7f00:1",
  "2002:7f00:1::",
  "ff02::1",
])("rejects local and translated local address %s", async (address) => {
  expect(await publicAddresses(address)).toBeUndefined();
});
