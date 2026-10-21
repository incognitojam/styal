import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  os: "android",
  version: 36,
  openSettings: vi.fn(),
  native: null as {
    configure?: ReturnType<typeof vi.fn>;
    clear?: ReturnType<typeof vi.fn>;
    openLiveUpdateSettings?: ReturnType<typeof vi.fn>;
    openChannelSettings?: ReturnType<typeof vi.fn>;
  } | null,
  config: { scheme: ["t3code-preview"], extra: { iosPersonalTeamBuild: false } },
  requireModule: vi.fn(),
}));

vi.mock("expo", () => ({ requireOptionalNativeModule: mocks.requireModule }));
vi.mock("expo-constants", () => ({ default: { expoConfig: mocks.config } }));
vi.mock("react-native", () => ({
  Linking: { openSettings: mocks.openSettings },
  Platform: {
    get Version() {
      return mocks.version;
    },
    get OS() {
      return mocks.os;
    },
  },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.os = "android";
  mocks.version = 36;
  mocks.openSettings.mockReset().mockResolvedValue(undefined);
  mocks.native = { configure: vi.fn(), clear: vi.fn() };
  mocks.config.extra.iosPersonalTeamBuild = false;
  mocks.requireModule.mockReset().mockImplementation(() => mocks.native);
});

describe("Android native notification capability", () => {
  it("opens a channel's Android settings, or app settings on binaries without it", async () => {
    mocks.native!.openChannelSettings = vi.fn(() => true);
    const { openAndroidAgentChannelSettings } = await import("./androidNotifications");
    await openAndroidAgentChannelSettings("alerts");
    expect(mocks.native!.openChannelSettings).toHaveBeenCalledWith("alerts");
    expect(mocks.openSettings).not.toHaveBeenCalled();
    delete mocks.native!.openChannelSettings;
    await openAndroidAgentChannelSettings("activity");
    expect(mocks.openSettings).toHaveBeenCalledOnce();
  });
});
