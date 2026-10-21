import { describe, expect, it } from "vite-plus/test";
import { updateDeviceHosts } from "./deviceHostsSettings.logic";

describe("device host changes across environments", () => {
  const shared = {
    kind: "ssh" as const,
    id: "shared",
    label: "Mac mini",
    target: "julius@macmini",
  };
  const local = { kind: "ssh" as const, id: "other", label: "Android", target: "julius@android" };

  it("does not copy an edited host into environments without a matching saved host", () => {
    const environments = [[], [local], [shared, local]];
    const edited = { ...shared, label: "Renamed device host" };
    const saved = environments.map((hosts) => updateDeviceHosts(hosts, edited, false, shared));
    expect(saved).toEqual([[], [local], [edited, local]]);
    expect(saved[0]).toBe(environments[0]);
    expect(saved[1]).toBe(environments[1]);
    expect(saved.map((hosts) => updateDeviceHosts(hosts, edited, false, shared))).toEqual(saved);
    expect(saved.map((hosts) => updateDeviceHosts(hosts, edited, true))).toEqual([
      [],
      [local],
      [local],
    ]);
  });

  // regression: #11541 device settings edits must apply to selected environments only
  it("edits and removes the shared host while preserving unrelated hosts", () => {
    const edited = { ...shared, target: "julius@new-address" };
    const saved = [[shared], [local, shared]].map((hosts) =>
      updateDeviceHosts(hosts, edited, false),
    );
    expect(saved).toEqual([[edited], [local, edited]]);
    expect(saved.map((hosts) => updateDeviceHosts(hosts, edited, true))).toEqual([[], [local]]);
  });

  it("does not adopt an unrelated host when its destination matches the edited address", () => {
    const edited = { ...shared, target: "builder@renamed.example.test" };
    const unrelated = { ...local, target: edited.target };
    const hosts = [unrelated];
    expect(updateDeviceHosts(hosts, edited, false, shared)).toBe(hosts);
  });

  it("recognizes a host added separately on another environment and preserves its local ID", () => {
    const remote = { ...shared, id: "remote-id" };
    const edited = { ...shared, target: "julius@new-address" };
    expect(updateDeviceHosts([remote, local], shared, false)).toEqual([remote, local]);
    const saved = updateDeviceHosts([remote, local], edited, false, shared);
    expect(saved).toEqual([{ ...edited, id: remote.id }, local]);
    expect(updateDeviceHosts(saved, edited, false, shared)).toEqual(saved);
    expect(updateDeviceHosts([remote, local], shared, true)).toEqual([local]);
  });

  it("keeps distinct SSH connections to the same target separate", () => {
    const anotherPort = { ...shared, id: "another-port", port: 2222 };
    const anotherIdentity = { ...shared, id: "another-key", identityFile: "~/.ssh/another" };
    expect(updateDeviceHosts([anotherPort, anotherIdentity], shared, false)).toEqual([
      anotherPort,
      anotherIdentity,
    ]);
  });

  it("prefers the selected ID over a sibling with the same destination", () => {
    const sibling = { ...shared, id: "sibling", label: "Another entry" };
    const edited = { ...shared, label: "Renamed" };
    expect(updateDeviceHosts([sibling, shared], edited, false, shared)).toEqual([sibling, edited]);
    expect(updateDeviceHosts([sibling, shared], shared, true)).toEqual([sibling]);
  });

  it("refuses an ambiguous destination on another environment instead of changing a sibling", () => {
    const remote = { ...shared, id: "remote" };
    const sibling = { ...shared, id: "sibling" };
    expect(() => updateDeviceHosts([remote, sibling], shared, true)).toThrow("Multiple hosts");
    expect(() => updateDeviceHosts([remote, sibling], shared, false)).toThrow("Multiple hosts");
  });
});
