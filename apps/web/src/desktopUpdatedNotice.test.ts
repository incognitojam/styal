import { describe, expect, it } from "vite-plus/test";

import {
  decideDesktopUpdatedNotice,
  startDesktopUpdatedNotice,
  type LastSeenVersionStore,
  type WindowAttention,
} from "./desktopUpdatedNotice";

describe("decideDesktopUpdatedNotice", () => {
  it("announces a newer stable or nightly version", () => {
    expect(decideDesktopUpdatedNotice("1.2.0", "1.3.0")).toEqual({
      announce: "1.3.0",
      record: true,
    });
    expect(decideDesktopUpdatedNotice("1.2.0", "1.2.1-nightly.20261021.4")).toEqual({
      announce: "1.2.1-nightly.20261021.4",
      record: true,
    });
    // Numeric prerelease segments compare as numbers, not text.
    expect(
      decideDesktopUpdatedNotice("1.2.1-nightly.20261021.9", "1.2.1-nightly.20261021.10").announce,
    ).toBe("1.2.1-nightly.20261021.10");
    // The release a nightly was leading up to is newer than that nightly.
    expect(decideDesktopUpdatedNotice("1.2.1-nightly.20261021.4", "1.2.1").announce).toBe("1.2.1");
  });

  it("records a first run silently", () => {
    expect(decideDesktopUpdatedNotice(null, "1.2.0")).toEqual({ announce: null, record: true });
  });

  it("records a downgrade or a switch to a lower channel silently", () => {
    expect(decideDesktopUpdatedNotice("1.3.0", "1.2.0")).toEqual({ announce: null, record: true });
    expect(decideDesktopUpdatedNotice("1.2.1-nightly.20261021.4", "1.2.0")).toEqual({
      announce: null,
      record: true,
    });
  });

  it("does nothing when the version is unchanged", () => {
    expect(decideDesktopUpdatedNotice("1.2.0", "1.2.0")).toEqual({ announce: null, record: false });
  });

  it("does not announce versions that do not parse", () => {
    expect(decideDesktopUpdatedNotice("garbage", "1.2.0")).toEqual({
      announce: null,
      record: true,
    });
    expect(decideDesktopUpdatedNotice("1.2.0", "")).toEqual({ announce: null, record: false });
  });
});

function memoryStore(initial: string | null): LastSeenVersionStore & { value: string | null } {
  const store = {
    value: initial,
    read: () => store.value,
    write: (version: string) => {
      store.value = version;
    },
  };
  return store;
}

function fakeAttention(initiallyAttended: boolean) {
  let attended = initiallyAttended;
  const listeners = new Set<() => void>();
  const attention: WindowAttention = {
    isAttended: () => attended,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    attention,
    listenerCount: () => listeners.size,
    set(next: boolean) {
      attended = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("startDesktopUpdatedNotice", () => {
  it("shows a newer version immediately when the window is looked at, once", () => {
    const store = memoryStore("1.2.0");
    const shown: string[] = [];
    const window = fakeAttention(true);
    const start = () =>
      startDesktopUpdatedNotice({
        currentVersion: "1.3.0",
        store,
        attention: window.attention,
        show: (version) => shown.push(version),
      });

    start();
    expect(shown).toEqual(["1.3.0"]);
    expect(store.value).toBe("1.3.0");
    expect(window.listenerCount()).toBe(0);

    // A reload or remount on the same version stays quiet.
    start();
    expect(shown).toEqual(["1.3.0"]);
  });

  it("waits until a hidden or unfocused window is looked at", () => {
    const store = memoryStore("1.2.0");
    const shown: string[] = [];
    const window = fakeAttention(false);
    startDesktopUpdatedNotice({
      currentVersion: "1.3.0",
      store,
      attention: window.attention,
      show: (version) => shown.push(version),
    });

    expect(shown).toEqual([]);
    // Not recorded yet, so quitting before the window is seen announces it next launch.
    expect(store.value).toBe("1.2.0");

    window.set(true);
    window.set(false);
    window.set(true);
    expect(shown).toEqual(["1.3.0"]);
    expect(store.value).toBe("1.3.0");
    expect(window.listenerCount()).toBe(0);
  });

  it("stops waiting on cleanup", () => {
    const store = memoryStore("1.2.0");
    const shown: string[] = [];
    const window = fakeAttention(false);
    const stop = startDesktopUpdatedNotice({
      currentVersion: "1.3.0",
      store,
      attention: window.attention,
      show: (version) => shown.push(version),
    });

    stop();
    window.set(true);
    expect(shown).toEqual([]);
    expect(store.value).toBe("1.2.0");
    expect(window.listenerCount()).toBe(0);
  });

  it("skips the notice when another mount showed it while waiting", () => {
    const store = memoryStore("1.2.0");
    const shown: string[] = [];
    const window = fakeAttention(false);
    for (let mount = 0; mount < 2; mount += 1) {
      startDesktopUpdatedNotice({
        currentVersion: "1.3.0",
        store,
        attention: window.attention,
        show: (version) => shown.push(version),
      });
    }

    window.set(true);
    expect(shown).toEqual(["1.3.0"]);
  });

  it("records a first run without waiting or showing", () => {
    const store = memoryStore(null);
    const shown: string[] = [];
    const window = fakeAttention(false);
    startDesktopUpdatedNotice({
      currentVersion: "1.3.0",
      store,
      attention: window.attention,
      show: (version) => shown.push(version),
    });

    expect(store.value).toBe("1.3.0");
    expect(window.listenerCount()).toBe(0);
    window.set(true);
    expect(shown).toEqual([]);
  });
});
