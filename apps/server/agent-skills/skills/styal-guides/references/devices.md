# Devices: iOS simulators, Android emulators and phones

The Device panel shows a live simulator, emulator or connected Android phone next to a thread.
Agents use `device_list`, `device_open`, `device_screenshot` and `device_close`, and drive the
device with the `agent-device` command line, which styal installs. The tools are always listed, but
calls fail with an error until the user turns on **Agents can use devices**.

## Helping the user set up

Local devices run on the machine that hosts the environment server. Devices can also come from
an SSH device host, EAS cloud simulators, or a Simlock pool (alpha, enabled in Settings → Labs).

- **iOS**: macOS with Xcode and at least one simulator runtime.
- **Android**: SDK Platform-Tools, Android Emulator and Command-line Tools (latest), plus a
  virtual device created in Android Studio's Device Manager. Set `ANDROID_HOME` for a
  non-standard SDK location. Emulator video needs `ffmpeg` with libx264 on PATH, or
  `SERVE_EMU_FFMPEG` pointing at one.
- **Physical Android**: the same SDK components, but no virtual device or `ffmpeg`. USB or
  wireless debugging enabled, the debugging prompt accepted, and no screen lock (agents cannot
  unlock it).
- After installing SDK tools or changing PATH, restart the environment server for local devices, or
  turn device support off and on for an SSH host.

Then the user opens a project thread and chooses **Device** in the right panel. On first use it
walks through three setup steps: device hub, simulator support and agent access. After that,
**Agents can use devices** is in Settings → Devices; choose a project scope there to override it. An agent session started before access was granted keeps getting refused until it
restarts.

## Working with devices

- `device_open` takes `deviceId` and `hostId` from `device_list` and returns an `agent-device`
  command for that device. Use it for every app launch, deep link, tap, text entry, alert, setting,
  screenshot and recording so the user can watch. Do not use `simctl`, `idb`, `adb` or ssh for
  those; they stay fine for builds, installs, code sync, Metro, port forwards, logs and test runners.
  If you lose the command, call `device_open` again.
- `device_list` lists devices and this thread's open sessions; it cannot tell whether another
  thread or the user is using a device. Use a device you opened, or ask before using a booted
  device you did not open. Two threads can open the same device.
- Close your panel session with `device_close` when finished or unable to continue. `shutdown: true`
  turns the device off for everyone. Afterwards, say what happened and what could not be finished.
- styal does not build apps; build with the project's own tooling. Install with
  `agent-device install` from the `device_open` quick start or with the project's tooling. For an
  SSH device host, use ssh for builds, code sync and Metro. A phone or a device on another
  machine cannot reach a dev server (such as Metro) on this machine's localhost without forwarding
  or a reachable address.
- Settings → Devices holds the device hub switch, agent access and device sources.
