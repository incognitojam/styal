# Devices

The Device panel shows a live iOS Simulator or Android Emulator next to a
thread, so you can watch an agent verify mobile work and tap the device
yourself. Agents get the same device through `device_*` tools and the
`agent-device` command line, which styal sets up for them.

## Open a device

Open the right panel in a project thread and choose **Device**. On first use,
the panel walks through three steps: starting the device hub, checking iOS and
Android support, and choosing whether agents may control devices. Opening the
panel alone does not download or start anything. If the hub is already
installed, the setup screen says so and reuses it.

Choose a running device to watch it, or choose **Start** next to a stopped
device to boot it. The panel shows when you or an agent starts a device.
Each device opens in its own tab. Use **+ → Device** to open another, and
double-click a tab name or choose **Rename** from its context menu to rename it.
Only the visible tab streams video; switching tabs keeps both devices running.
Choose **Float device over chat** in the toolbar to keep watching the device in a
small window while the right panel shows something else. The floating window is
view-only: drag it from anywhere, resize it from any edge, and double-click it or
use **Open in right panel** to tap and type on the device again.
In **Settings → Integrations**, turn off the device hub on its environment to stop the
helper processes; simulators and emulators keep running until you power them
off.

Simulators run on the machine that hosts the environment server. iOS needs
macOS with Xcode. Android needs the SDK Platform-Tools, Android Emulator,
and Command-line Tools (latest), plus a virtual device created in Android
Studio's Device Manager. styal detects standard SDK locations; set
`ANDROID_HOME` for a custom location. The panel explains missing dependencies.
After installing SDK tools, restart the environment server and refresh devices.

Android emulator video also needs `ffmpeg` with the libx264 encoder on the device
host's PATH, or an executable selected by `SERVE_EMU_FFMPEG` on that host. If
opening an emulator reports an ffmpeg problem, install or fix the executable
and retry opening it. After changing PATH or `SERVE_EMU_FFMPEG`, restart the
environment server for local devices, or turn device support off and on for SSH
devices, so the running tools inherit the new environment. Physical Android
devices and iOS do not need ffmpeg.

## Physical Android devices

A phone connected to the environment server with USB debugging enabled appears
in the device list next to emulators, as does one paired over wireless debugging.
Accept the debugging prompt on the phone and remove its screen lock: agents
cannot unlock it.

While a thread holds the phone, its screen stays dark and the phone stays
awake. Streaming and input keep working. A thread holds a device from when it
is opened in the Device panel or by an agent until the agent hands it back or
the thread is archived; closing the Device panel tab does not release it. The
screen comes back on when no thread holds the phone. A phone on wireless
debugging only stays awake while it is charging. To keep the screen
on, turn off **Turn off physical Android screens** in the environment’s
**Device maintenance** section in **Settings → Integrations**, or **Settings →
Devices** in the mobile app. Press the phone's
power button twice to light the screen while styal holds it.

The screen is interactive: click and drag to touch, type while the screen is
focused, and use the toolbar for Home, Back, and Recents on Android, rotate on
iOS, and power off. Close the tab to stop watching; the device keeps running
unless you power it off. Closed tabs stay closed after a reload. To watch the
device again, choose it from **+ → Device**.

Choose **3D view** to inspect supported devices while the live screen stays
interactive. On iPhone Duo, use the fold and stance controls to change its
physical pose, or pinch over the device to adjust the hinge. Turning the model
to the other screen switches the live display and touch input to that screen.
**Restore 3D view** returns the device to a screen-facing position.
On supported Android foldables, use **Fold device** and **Unfold device** beside
the screen to change its posture in either view.

## Tools

The toolbar's **Tools** button opens a drawer for the open device. It shows the
foreground app, and lets you switch light and dark mode, change text size,
flip accessibility settings, overlay the accessibility element frames on the
screen, set a fake location, and grant or revoke app permissions. iOS also
exposes Liquid Glass, color filters, VoiceOver, and sending a test push
notification; Android adds orientation and toggling the network. The drawer
only shows what the platform can do, and every control reflects the value read
back from the device after a change.

## Simulator memory

Choose **Simulator memory** in **Settings → Integrations → Devices** on web or desktop, or **Settings → Devices** on mobile. To save a project's preference, select the project in **Settings → Projects** and use **Devices**. **Standard** is the default; **Low memory** reduces background services while keeping push notifications, purchases, universal links, iCloud, keychain sync, photos, contacts, and calendar. Use Standard when testing other OS integrations.

styal applies the preference before starting a stopped iOS simulator that no thread holds. Opening an already running or claimed device leaves its mode unchanged. Agents inherit the preference automatically. Low memory requires an Apple Silicon Mac and iOS 18.5 or newer; its first use downloads a verified helper onto the simulator's Mac. When a Mac, runtime, or connected environment cannot use Low memory, the simulator starts normally and styal shows a warning. Local, SSH, and connected-environment hosts use the same preset. Android emulators are unchanged.

The applied mode persists across simulator boots, including boots outside styal. Changing the preference does not immediately change a running simulator. To restore services, choose Standard, stop the simulator, and start it through styal after its other threads release it. The helper's per-device overrides can survive erasing simulator data; a new simulator starts with standard services.

## Agents and devices

When an agent opens a device, it floats over the chat in web and desktop clients
connected to the thread, the same way an agent-driven browser does. Turn off
**Auto-show floating preview** in **Settings → Integrations → Browser preferences** to switch the
right panel to it instead. Either way, every device the thread has open keeps a tab
in the right panel unless you close that tab. In the mobile app, open the agent's thread and tap the
device button above the composer to watch the live screen and control it.
If the thread has several devices open, choose one in the viewer. Closing the
viewer stops streaming and leaves the device available to the agent. Device
activity also appears in the thread timeline.

Agents can see which thread holds each device. An agent cannot open a device
another thread's agent is working on, or that someone is watching, unless you
tell it to take the device over, so for parallel work start another simulator or
emulator. Opening a device in your own Device panel never takes it from an agent.

Agents drive the device through the `agent-device` command line. styal
installs and starts it only after **Agent device access** is enabled. iOS
taps build a small test runner on first use, which takes a couple of minutes
once per server. Restart an existing agent session after granting access so it
receives the device CLI environment.

To keep agents away from simulators, turn off **Agent device access** in
**Settings → Integrations** on its environment. This hides the device tools from agents
started from then on; your own Device panel is unaffected.

## Idle devices

Agents hand a device back when they finish testing, so other threads can use it; it stays booted. A device held by a thread that is not working is handed to the next agent that needs one, so agents only take turns when devices run short; hand-over happens within an environment, not across connected environments. Archiving or deleting a thread releases its devices. Simulators and emulators styal started shut down once no working thread holds them and nobody has watched them for 10 minutes, even if one is still open in a Device panel tab; devices you started yourself keep running. Change the period or choose **Never** under **Shut down idle devices** in the environment’s **Device maintenance** section in **Settings → Integrations**, or **Settings → Devices** in the mobile app.

## Remote connections

The device stream goes through the environment server, so it works over the
local network, Tailscale, and styal Link. Live video needs a secure page
(HTTPS or localhost); on a plain-HTTP remote origin iOS falls back to a slower
still-image stream and Android cannot show video.

## Devices from another environment

If the machine with your simulators already runs styal, connect both environments to your client. In **Settings → Integrations**, under the environment that has the simulators, turn on **Share with** for the environment whose agents should use them. In the native mobile app, use **Settings → Devices**. Both environment servers need a version that supports sharing.

This enables device hub and agent access on both environments and grants the agent environment access to the other machine’s local devices. Access stays available after you close the browser or mobile app; it does not grant access to projects, files, or terminals. Turning off device hub or agent device access on either environment pauses sharing until it is turned back on. The device machine still needs Xcode for iOS or an Android SDK for Android. As with SSH hosts, a simulator on the device machine cannot reach Metro through the agent environment's localhost.

The agent environment tries the available addresses automatically, including your client's connection address, the LAN and Tailscale addresses the device environment's server is listening on, and its styal Link address when known. You do not need to choose an address. If the active address becomes unreachable, it tries the other saved addresses. For the desktop app’s own server, enable network access, Tailscale, or styal Link in **Settings → Connections**. A command-line server lists its LAN addresses only when started with a network `--host`, as in [Pair over a LAN or private network](./remote-access.md#pair-over-a-lan-or-private-network). Sharing is unavailable when the device environment is only reachable through an SSH tunnel.

Turn the switch off to revoke access, even after device hub or agent access has been disabled. Saved shares stay removable while the agent environment is connected, including when the device environment is offline or has been removed from your client. If the device environment is offline during removal, revoke the matching **Devices for…** session in its Connections settings when it comes back online. Access expires after a year; turn sharing off and on to renew it. Enabling sharing again also picks up newly added addresses; existing single-address shares keep working.

Shared inventory includes devices open in other environments’ threads. Use a separate simulator or emulator for each agent working in parallel.

## Existing SSH device hosts

Previously configured SSH device hosts keep working. In **Settings → Integrations**,
find its environment and expand **Existing SSH device hosts** to test, edit, or remove them. For new remote
device access, [connect and share the device environment](#devices-from-another-environment).

SSH aliases, identity files, and ports resolve on the environment server, so use
the SSH configuration and keys available there. Password prompts are not supported.

**Test connection** checks SSH, Node, npm, and platform tools without installing
anything, using the selected host’s environment. Targets that resolve to
the environment’s own machine are skipped, since its devices are already local.
The first device listing installs pinned device tools on the host.
Node 22 or newer and npm must be available to non-interactive SSH commands.
styal checks common Homebrew and Android SDK locations; custom installations need
the appropriate PATH and ANDROID_HOME on the host. Android emulator video needs
`ffmpeg` with libx264 on that host; physical Android devices use scrcpy and do
not need ffmpeg.

The picker identifies devices by host when several hosts are configured.
Connections recover after interruptions. Removing a host closes its device
sessions and stops its styal helpers when reachable; simulators keep running.

styal provides discovery, streaming, and control. Arrange app builds,
installation, and connectivity to development servers such as Metro separately.
A simulator on another machine cannot reach Metro through your environment's
localhost without forwarding or another reachable address.

## Device tool updates

The connected T3 server manages the device hub and agent tools on its own machine and configured SSH hosts. Required versions install automatically the next time those tools are used. Use the version controls in Settings → Integrations on the relevant environment to read installed versions without installing tools or starting devices.

To receive newer tool versions on a remote environment, update that environment's T3 server. Updating only the browser or mobile app does not update the remote server. An offline host keeps its installed files, but an update needs network access before device support can start; T3 does not fall back to an older version. Reconnect the host and use Retry if installation fails. Existing device and agent-access settings are preserved.
