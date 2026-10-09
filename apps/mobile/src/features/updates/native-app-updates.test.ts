import { describe, expect, it, vi } from "vite-plus/test";

import {
  createNativeAppUpdateStore,
  newestAndroidReleaseTag,
  resolveNativeAppUpdate,
  runNativeAppUpdateCheck,
  type NativeAppUpdateEnvironment,
} from "./native-app-updates";

vi.mock("expo-updates", () => ({ isEnabled: true, runtimeVersion: "installed" }));
vi.mock("expo-constants", () => ({ default: { platform: { android: {} }, expoConfig: {} } }));

const INSTALLED_RUNTIME = "1852261bf06298ba91a15a6f681d1f0af8f33b51";
const NEWER_RUNTIME = "2e6594da84728ff5232cd75099aeff24beb27d26";

function manifest(runtimeVersion: string) {
  return {
    version: "1.3.1",
    versionCode: 16,
    runtimeVersion,
    apk: "styal-android-1.3.1-16.apk",
    apkSizeBytes: 194_517_504,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeEnvironment(
  responses: { readonly refs: Response; readonly manifest?: Response },
  overrides: Partial<NativeAppUpdateEnvironment> = {},
) {
  let promptedTag: string | undefined;
  const environment: NativeAppUpdateEnvironment = {
    isSupported: () => true,
    installedRuntimeVersion: () => INSTALLED_RUNTIME,
    fetch: vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/android-update.json")
        ? (responses.manifest ?? jsonResponse({}, 404))
        : responses.refs,
    ) as typeof fetch,
    loadPromptedTag: async () => promptedTag,
    savePromptedTag: async (tag) => {
      promptedTag = tag;
    },
    confirmDownload: vi.fn(async () => true),
    openDownload: vi.fn(async () => {}),
    ...overrides,
  };
  return environment;
}

const refs = [
  { ref: "refs/tags/android-1.2.1-13" },
  { ref: "refs/tags/android-1.3.1-16" },
  { ref: "refs/tags/android-1.3.0-15" },
];

describe("newestAndroidReleaseTag", () => {
  it("orders releases by versionCode rather than by name", () => {
    expect(
      newestAndroidReleaseTag([
        { ref: "refs/tags/android-1.9.0-9" },
        { ref: "refs/tags/android-1.10.0-10" },
      ]),
    ).toBe("android-1.10.0-10");
    expect(newestAndroidReleaseTag(refs)).toBe("android-1.3.1-16");
  });

  it("ignores tags that are not Android releases", () => {
    expect(
      newestAndroidReleaseTag([
        { ref: "refs/tags/android-preview" },
        { ref: "refs/tags/v1.4.0" },
        { ref: "refs/tags/android-1.3.0-15" },
      ]),
    ).toBe("android-1.3.0-15");
    // GitHub answers a prefix with no matches with an empty array, and errors
    // with an object.
    expect(newestAndroidReleaseTag([])).toBeUndefined();
    expect(newestAndroidReleaseTag({ message: "Not Found" })).toBeUndefined();
  });
});

describe("resolveNativeAppUpdate", () => {
  it("offers a release only when its runtime differs from the installed one", () => {
    expect(
      resolveNativeAppUpdate("android-1.3.1-16", manifest(INSTALLED_RUNTIME), INSTALLED_RUNTIME),
    ).toBeUndefined();
    expect(
      resolveNativeAppUpdate("android-1.3.1-16", manifest(NEWER_RUNTIME), INSTALLED_RUNTIME),
    ).toEqual({
      tag: "android-1.3.1-16",
      version: "1.3.1",
      apkUrl:
        "https://github.com/incognitojam/styal/releases/download/android-1.3.1-16/styal-android-1.3.1-16.apk",
      apkSizeBytes: 194_517_504,
    });
  });

  it("rejects a manifest whose APK name would leave the release", () => {
    expect(
      resolveNativeAppUpdate(
        "android-1.3.1-16",
        { ...manifest(NEWER_RUNTIME), apk: "../../evil.apk" },
        INSTALLED_RUNTIME,
      ),
    ).toBeUndefined();
  });
});

describe("runNativeAppUpdateCheck", () => {
  it("prompts once per release and opens the download when accepted", async () => {
    const store = createNativeAppUpdateStore();
    const environment = makeEnvironment({
      refs: jsonResponse(refs),
      manifest: jsonResponse(manifest(NEWER_RUNTIME)),
    });

    await runNativeAppUpdateCheck(environment, store);
    expect(store.current?.tag).toBe("android-1.3.1-16");
    expect(environment.confirmDownload).toHaveBeenCalledTimes(1);
    expect(environment.openDownload).toHaveBeenCalledWith(store.current);

    await runNativeAppUpdateCheck(environment, store);
    expect(environment.confirmDownload).toHaveBeenCalledTimes(1);
    // The About screen still offers the download after the prompt.
    expect(store.current?.tag).toBe("android-1.3.1-16");
  });

  it("does not open the download when the user chooses Later", async () => {
    const environment = makeEnvironment(
      { refs: jsonResponse(refs), manifest: jsonResponse(manifest(NEWER_RUNTIME)) },
      { confirmDownload: vi.fn(async () => false) },
    );
    await runNativeAppUpdateCheck(environment, createNativeAppUpdateStore());
    expect(environment.openDownload).not.toHaveBeenCalled();
  });

  it("stays quiet when the newest release matches or has no manifest", async () => {
    const current = makeEnvironment({
      refs: jsonResponse(refs),
      manifest: jsonResponse(manifest(INSTALLED_RUNTIME)),
    });
    const store = createNativeAppUpdateStore();
    await runNativeAppUpdateCheck(current, store);
    expect(store.current).toBeUndefined();
    expect(current.confirmDownload).not.toHaveBeenCalled();

    const withoutManifest = makeEnvironment({ refs: jsonResponse(refs) });
    await runNativeAppUpdateCheck(withoutManifest, store);
    expect(store.current).toBeUndefined();
    expect(withoutManifest.confirmDownload).not.toHaveBeenCalled();
  });

  it("clears the offer once the installed runtime matches the newest release", async () => {
    const store = createNativeAppUpdateStore();
    const listener = vi.fn();
    store.listeners.add(listener);
    await runNativeAppUpdateCheck(
      makeEnvironment({
        refs: jsonResponse(refs),
        manifest: jsonResponse(manifest(NEWER_RUNTIME)),
      }),
      store,
    );
    await runNativeAppUpdateCheck(
      makeEnvironment(
        { refs: jsonResponse(refs), manifest: jsonResponse(manifest(NEWER_RUNTIME)) },
        { installedRuntimeVersion: () => NEWER_RUNTIME },
      ),
      store,
    );
    expect(store.current).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the last result when GitHub cannot be reached", async () => {
    const store = createNativeAppUpdateStore();
    await runNativeAppUpdateCheck(
      makeEnvironment({
        refs: jsonResponse(refs),
        manifest: jsonResponse(manifest(NEWER_RUNTIME)),
      }),
      store,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const offline = makeEnvironment(
      { refs: jsonResponse({ message: "API rate limit exceeded" }, 403) },
      { fetch: vi.fn(async () => Promise.reject(new TypeError("Network request failed"))) },
    );
    await runNativeAppUpdateCheck(offline, store);
    expect(store.current?.tag).toBe("android-1.3.1-16");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
