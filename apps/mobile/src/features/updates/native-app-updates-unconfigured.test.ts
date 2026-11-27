import { expect, it, vi } from "vite-plus/test";

import { findNativeAppUpdate } from "./native-app-updates";

vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("expo-device", () => ({}));
vi.mock("expo-updates", () => ({}));
vi.mock("react-native", () => ({}));

it("makes no request when the Android release repository is unset", async () => {
  const fetcher = vi.fn<typeof fetch>();
  expect(await findNativeAppUpdate(fetcher, "installed")).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});
