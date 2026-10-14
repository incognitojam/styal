import { AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { offlineDeviceShares } from "./device.ts";

const atlas = EnvironmentId.make("atlas");
const orion = EnvironmentId.make("orion");
const other = EnvironmentId.make("other");
const host = {
  id: "environment-orion",
  environmentId: orion,
  label: "Orion",
  url: "https://orion.test",
  sessionId: AuthSessionId.make("synthetic-session"),
};
const agent = {
  environmentId: atlas,
  serverConfig: { settings: { environmentDeviceHosts: [host] } },
};
const owner = { environmentId: orion, serverConfig: { settings: { environmentDeviceHosts: [] } } };

it("keeps a saved share removable when only its agent environment is connected", () => {
  expect(offlineDeviceShares([agent], null)).toEqual([{ agent, host }]);
});

it("uses saved metadata even when the owner has been removed from the client", () => {
  expect(offlineDeviceShares([agent], new Set([atlas]))).toEqual([{ agent, host }]);
  expect(offlineDeviceShares([agent], new Set([orion]))).toEqual([{ agent, host }]);
  expect(offlineDeviceShares([agent], new Set([other]))).toEqual([]);
});

it("hands a reconnected owner back to the ordinary sharing controls without duplicates", () => {
  expect(offlineDeviceShares([agent, owner], null)).toEqual([]);
});

it("offers no removal action when the environment holding the grant is disconnected", () => {
  expect(offlineDeviceShares([owner], null)).toEqual([]);
});
