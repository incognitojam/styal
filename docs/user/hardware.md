# Hardware

Hardware lets agents work with a physical device on your network, such as a
microcontroller with an HTTP API, without stepping on each other or doing
anything risky without you. One thread holds a device at a time. Agents read its
status whenever they like, need the lease to change anything, and wait for your
approval before actions you marked as risky, such as pushing firmware or
rebooting.

## Describe the device in its repository

Each device has a definition file in the project that owns it, under
`.styal/hardware/`, for example `.styal/hardware/tree.json`. It lists the
device's actions, which tier each runs at, an optional health check, and the
hooks styal runs when a lease starts, while it lasts, and when it ends:

```json
{
  "type": "ldn-house-tree",
  "name": "Christmas tree",
  "health": { "path": "/", "summary": ["version.commit", "animation"] },
  "hooks": { "release": [{ "action": "calibrate.stop" }] },
  "actions": {
    "status": { "method": "GET", "path": "/", "tier": "read" },
    "calibrate.led": {
      "method": "GET",
      "path": "/calibrate/led",
      "tier": "operate",
      "query": ["n"]
    },
    "calibrate.stop": { "method": "GET", "path": "/calibrate/stop", "tier": "operate" },
    "reboot": { "method": "POST", "path": "/reboot", "tier": "approve" }
  }
}
```

- `read` actions run without a lease, even while another thread holds the device.
- `operate` actions need the caller to hold the lease.
- `approve` actions also wait for you to approve each call, or to allow it for the
  rest of that lease.

styal reads the file from the repository's default branch on its remote, such as
`origin/main`, so a change takes effect once it is merged. Agents can propose
changes in an ordinary pull request.

## Add a device

In **Settings → Hardware**, add the device: an id, the project whose repository
holds the definition, the definition file name, and the device's address, such
as `http://192.168.2.149:8080` or a Tailscale name. The device must be reachable
from the machine that runs the environment server. If the device checks a token,
store it under the device; styal sends it with every request and agents never
see it.

The first time, open the device's details, review the definition and choose
**Accept definition**. Until you do, every action needs your approval and no
hooks run. After that, changes that only make things stricter apply as soon as
they reach the default branch. Changes that loosen anything, such as a lower
tier, a new action, or different hooks, wait for you to choose **Accept
changes**; meanwhile the rules you last accepted stay in force.

Turn on **Agent hardware access** on the same page, for every project or for
one. Agents already running pick it up in their next session.

## Leases

An agent takes the lease with `hardware_acquire` and gives it back with
`hardware_release`. While its thread is working, the lease never runs out. Once
the thread goes idle, the lease ends after 30 minutes without activity by
default, and every lease ends after 8 hours. Ending a lease always runs the
device's release hooks, for example to leave calibration mode, whether the agent
released it, you revoked it, or it ran out, even while the server was stopped.

While a thread holds a device, its header shows a chip with the device name. Use
it to release the lease, or to keep it until you release it yourself, for
example while you move a camera between angles. **Settings → Hardware** shows
who holds each device and who is waiting, and lets you revoke a lease or pause a
device so no agent can use it.

Scripts can use the device too. `hardware_acquire` returns a local proxy URL
that forwards `read` and `operate` actions for that lease, so a capture script
can light LEDs while a camera records. The URL stops working when the lease
ends. `approve` actions only run through `hardware_call`, where you can see and
answer them.

Each device keeps an activity log of leases, calls, approvals and hooks, with
repeated identical calls folded into one line.

## Limits

styal can only enforce leases for requests that go through it. If the device
accepts requests from anyone on your network, an agent that calls its address
directly bypasses the lease and approvals. To make the lease a real lock, have
the device require a token and store that token only in styal.
