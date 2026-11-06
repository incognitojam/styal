import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { RelayDeviceRegistrationRequest, RelaySignInCode } from "./relay.ts";

const decodeSignInCode = Schema.decodeUnknownExit(RelaySignInCode);
const decodeDevice = Schema.decodeUnknownExit(RelayDeviceRegistrationRequest);
const device = {
  deviceId: "device",
  label: "Phone",
  pushToken: "token",
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

describe("mobile device platforms", () => {
  it("rejects missing platform versions and Apple activity tokens on Android", () => {
    expect(decodeDevice({ ...device, platform: "ios" })._tag).toBe("Failure");
    expect(decodeDevice({ ...device, platform: "android" })._tag).toBe("Failure");
    expect(
      decodeDevice({
        ...device,
        platform: "android",
        androidApiLevel: 36,
        pushToStartToken: "apple-token",
      })._tag,
    ).toBe("Failure");
  });
});

describe("email sign-in codes", () => {
  it.each(["00000000", "12345678", "99999999"])("accepts eight digits: %s", (code) => {
    expect(decodeSignInCode(code)._tag).toBe("Success");
  });
  it.each(["123456", "1234567", "123456789", "1234abcd", "１２３４５６７８"])(
    "rejects invalid code: %s",
    (code) => {
      expect(decodeSignInCode(code)._tag).toBe("Failure");
    },
  );
});
