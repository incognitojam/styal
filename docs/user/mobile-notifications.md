# Mobile notifications

Sign in to styal Link, link your environments, and enable **Device Notifications** (**Agent alerts** on Android) in **Settings → Notifications** to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Your environment must have agent activity publishing enabled.

Use the switches under **Notify me when an agent** to choose which of those alerts reach this device, for example only approvals and input requests. Each device keeps its own choice.

Enable **Ongoing agent activity** on Android or **Live Activity Updates** on iOS to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off ongoing activity in Settings to stop future cards.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission is controlled in system Settings. On Android, styal's notification categories there are **Agent alerts** and **Ongoing agent activity**; if you switch one off there, the matching styal setting shows it as off, and turning it back on in styal opens that Android page. On Android 16 and newer, **Settings → Notifications → Live Updates** opens Android's setting for showing working agents in the status bar. Background delivery requires styal Link; a direct or Tailscale connection alone does not enable push notifications. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.
