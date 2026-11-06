import * as Schema from "effect/Schema";

export const AgentGuideTopic = Schema.Literals([
  "project-setup",
  "devices",
  "hardware",
  "data-import",
  "troubleshooting",
]);
export type AgentGuideTopic = typeof AgentGuideTopic.Type;

const projectSetup = `# Project setup: styal.json, actions and worktrees

## styal.json

\`styal.json\` at the project root is the project file. styal reads actions,
\`defaultThreadEnvMode\` and \`iconPath\` from the file in the project's registered checkout, on
whichever branch is checked out there, not from a thread's worktree. An edit in a worktree affects
these only once it reaches that checkout (usually by merging to the default branch and pulling).
\`worktreeSubmodules\` is different: it is read from the new worktree's own copy of the file when
the worktree is created.

\`\`\`json
{
  "$schema": "https://styal.build/schema/styal.json",
  "defaultThreadEnvMode": "worktree",
  "actions": [
    { "id": "install", "name": "Install", "command": "pnpm install", "icon": "configure", "runOnWorktreeCreate": true, "async": false },
    { "id": "dev", "name": "Dev server", "command": "pnpm dev -- --port \\"$STYAL_WORKSPACE_PORT\\"", "icon": "play" },
    { "id": "test", "name": "Test", "command": "pnpm test", "icon": "test" }
  ]
}
\`\`\`

- Top-level fields: \`actions\`, \`defaultThreadEnvMode\` (\`worktree\` or \`local\`),
  \`worktreeSubmodules\` (\`recursive\`, \`top-level\` or \`none\`), \`iconPath\` (project-relative
  image). Comments and trailing commas are allowed.
- Action fields: \`name\` and \`command\` (required); \`id\` (at most 24 characters: lowercase letters,
  digits and dashes, starting with a letter or digit; always set it so shortcuts survive a rename); \`icon\` (\`play\`, \`test\`, \`lint\`, \`configure\`,
  \`build\`, \`debug\`, \`desktop\`, \`database\`, \`deploy\`); \`runOnWorktreeCreate\`; \`runOnSettle\`;
  \`async\` (setup actions only; defaults to true). When styal creates the worktree for a new
  thread, \`false\` holds the agent until the action exits, and a non-zero exit stops the agent from
  starting. An action still waiting for approval does not run, so the agent starts without it.
- An invalid or unrecognized field is ignored, and an action with an invalid or missing \`name\` or
  \`command\` is dropped. An action that repeats an earlier action's \`id\` is also dropped: the first
  action with the id wins. The rest of the file still applies. Settings → Projects → Actions shows a
  warning row, and its **Show details** lists each ignored value and dropped entry with its file line
  and reason.
- Malformed JSON, or a root that is not an object, makes styal ignore the whole file. Settings →
  Projects reports it as invalid, and a \`t3.json\` is not used instead.

## Choosing actions

Read the repository before proposing actions: package manager and lockfile, \`package.json\`
scripts, Makefile or justfile, README setup steps, and CI workflows. Offer a few actions people
run often (dev server, tests, lint, build). Prefer existing scripts over inlined command chains.

- **Setup** (\`runOnWorktreeCreate\`): runs in each new worktree before or alongside the agent.
  Typical work: install dependencies and copy untracked local files from the original checkout,
  for example \`cp "$STYAL_PROJECT_ROOT/.env" .env\`. Make it safe to run twice. Set \`"async": false\` when the agent cannot work until it
  finishes. Declare this role on one action only: styal runs one setup action per checkout, the
  first saved action with the role, otherwise the first \`styal.json\` action with the role whose
  command is approved.
- **Settle** (\`runOnSettle\`): runs in the worktree each time the last open thread in it settles, for
  example to stop dev servers on the workspace ports or delete large build output. Another thread
  holds the action back if it is unsettled and not a subagent, or if it is working, waiting on a
  request, or has queued work. An idle subagent does not hold it back, and one that settles after its
  parent runs the action again, so make the action safe to run twice. One action per checkout runs,
  chosen the same way as setup.
- Actions run by hand run in the thread's worktree, or the project root for a local thread, using
  the environment's shell. Setup and settle actions run only in a separate worktree, never in a
  local thread or the project's own checkout. Shared actions should work on every OS the team uses.

Environment variables available to actions:

- \`STYAL_PROJECT_ROOT\`: the registered checkout, even inside a worktree.
- \`STYAL_WORKTREE_PATH\`: the thread's worktree; unset for local threads.
- \`STYAL_WORKSPACE_PORT\`: first of ten stable ports reserved for this workspace. Use it, and
  \`$((STYAL_WORKSPACE_PORT + 1))\` and so on, instead of fixed ports so parallel worktrees do not
  collide.

## What stops a dev server

| Rule | Scope | When | Covers |
| --- | --- | --- | --- |
| Session scope stop | One thread | That thread settles and its idle session closes | Claude on Linux with systemd, including detached servers, even if another thread in the worktree is open |
| Servers list and **Stop** in thread details | One server | The user clicks **Stop** | Listening servers started by a Claude thread or a styal terminal. Not other providers' threads such as Codex, not processes that listen on nothing, and no **Stop** on Windows |
| Settle action | The whole worktree | The last open thread settles | Whatever the action does. Use it for terminal servers, macOS, Codex and deleting files |

A command running in a terminal stays open when a thread settles.

## Approval

An action from \`styal.json\` with \`runOnWorktreeCreate\` or \`runOnSettle\` does not run on its
own until the user approves its exact command. You cannot approve it. After you write or change
one, tell the user to choose **Review** next to it in Settings → Projects → Actions, or in the
thread's work log when it is waiting, on web or desktop. Mobile only shows that it needs approval.
Settings and approval read the registered checkout, so if you edited the file in a worktree, Review
appears only after the edit reaches that checkout. Changing the command or adding an automatic role
asks again. Approval covers the command text, not the files it runs: later edits to a script the
command calls run without asking. Running an action by hand needs no approval.

## Committed or not

\`styal.json\` is meant to be committed so everyone who opens the repository gets the same actions.
Before writing one, check whether the project wants that: look at \`.gitignore\`, whether a
\`t3.json\` was committed, and ask the user if it is unclear. Do not commit it without the user's
agreement.

If the repository should not carry a styal file, do not write one. Actions the user saves in
Settings → Projects → Actions are stored in this environment's settings for that checkout and need
no file; suggest the commands and let the user add them there. Saved actions run automatically
without approval, and a saved setup or settle action takes that role before a file action. There is
no local-only styal file.

## Migrating from t3.json

A repository with only a \`t3.json\` (from T3 Code) keeps its settings, but its scripts, including
\`runOnWorktreeCreate\` and \`runOnSettle\`, do not appear or run until they are imported or migrated.

If the repository has only a \`t3.json\` and the user asks for actions, offer to migrate to
\`styal.json\`. Do not add to \`t3.json\`: a script added there does nothing.

**Migrate to styal.json** in Settings → Projects → Actions is for the user; you cannot press it, so
migrate by hand: \`scripts\` become \`actions\` with the same \`name\`, \`command\`, \`icon\`,
\`runOnWorktreeCreate\`, \`runOnSettle\` and \`async\`, plus an \`id\` for each, and other settings carry
over. Then send the user to **Review** for any setup or settle action (see Approval). Once
\`styal.json\` exists, \`t3.json\` is ignored entirely; delete it in the same commit if the user agrees.
If \`t3.json\` was not committed, ask whether the new file should be. A script the user already
imported stays saved and overrides a migrated action with the same id.

## Worktrees

New threads start in a fresh git worktree or in the current checkout. \`defaultThreadEnvMode\` and
\`worktreeSubmodules\` come from a project override in styal first, then a value set for the
environment, then \`styal.json\`, then the built-in default. So a value in the file does nothing
while the user has set one in Settings. Worktree branch naming lives in Settings → Worktrees.
\`t3_environment_read\` shows the environment's \`defaultThreadEnvMode\` but not
\`worktreeSubmodules\`. \`t3_project_read\` shows the project's \`workspaceRoot\`, which is the
registered checkout, and its stored record. It does not show \`styal.json\` actions, approval state
or overrides saved in Settings, so read \`styal.json\` from \`workspaceRoot\`.
`;

const devices = `# Devices: iOS simulators, Android emulators and phones

The Device panel shows a live simulator, emulator or connected Android phone next to a thread.
Agents use \`device_list\`, \`device_open\`, \`device_screenshot\` and \`device_close\`, and drive the
device with the \`agent-device\` command line, which styal installs. The tools are always listed, but
calls fail with an error until the user turns on **Agent device access**.

## Helping the user set up

Local devices run on the machine that hosts the environment server. Devices can also come from
another connected environment that shares them, an existing SSH device host, or EAS cloud
simulators.

- **iOS**: macOS with Xcode and at least one simulator runtime.
- **Android**: SDK Platform-Tools, Android Emulator and Command-line Tools (latest), plus a
  virtual device created in Android Studio's Device Manager. Set \`ANDROID_HOME\` for a
  non-standard SDK location. Emulator video needs \`ffmpeg\` with libx264 on PATH, or
  \`SERVE_EMU_FFMPEG\` pointing at one.
- **Physical Android**: the same SDK components, but no virtual device or \`ffmpeg\`. USB or
  wireless debugging enabled, the debugging prompt accepted, and no screen lock (agents cannot
  unlock it).
- After installing SDK tools or changing PATH, restart the environment server for local devices, or
  turn device support off and on for an SSH host.

Then the user opens a project thread and chooses **Device** in the right panel. On first use it
walks through three setup steps: device hub, simulator support and agent access. After that,
**Agent device access** is in Settings → Devices, and a project can override it in Settings →
Projects. An agent session started before access was granted keeps getting refused until it
restarts.

## Working with devices

- \`device_open\` takes \`deviceId\` and \`hostId\` from \`device_list\` and returns an \`agent-device\`
  command for that device. Use it for every app launch, deep link, tap, text entry, alert, setting,
  screenshot and recording so the user can watch. Do not use \`simctl\`, \`idb\`, \`adb\` or ssh for
  those; they stay fine for builds, installs, code sync, Metro, port forwards, logs and test runners.
  If you lose the command, call \`device_open\` again.
- An agent cannot open a device another thread is using: \`device_open\` fails naming that thread.
  A device held by an idle thread that nobody is watching is handed over automatically. Check
  \`device_list\` for who holds what, and use a free or stopped device (\`device_open\` boots it) or
  ask the user to create another one for parallel work. Do not take over a device another thread or
  the user is using unless the user says so.
- Hand a device back with \`device_close\` when you finish testing. While your turn is not running,
  another agent may take the device. Commands then report that it was handed over, so call
  \`device_open\` again.
- styal does not build apps; build with the project's own tooling. Install with
  \`agent-device install\` from the \`device_open\` quick start or with the project's tooling. For an
  SSH device host, use ssh for builds, code sync and Metro. A phone or a device on another
  machine cannot reach a dev server (such as Metro) on this machine's localhost without forwarding
  or a reachable address.
- Settings → Devices holds the device hub switch, agent access, simulator memory mode, idle
  shutdown and sharing devices from another connected environment.
`;

const hardware = `# Hardware: leased network devices

Hardware lets agents use a physical device on the network, such as a microcontroller with an HTTP
API, one thread at a time. Agents use \`hardware_list\`, \`hardware_acquire\`, \`hardware_call\` and
\`hardware_release\`. Never call a device's address directly: that bypasses the lease and the
user's approvals.

## Definition file

Each device has a definition in the project that owns it, at \`.styal/hardware/<name>.json\`:

\`\`\`json
{
  "type": "acme-led-strip",
  "name": "LED strip",
  "health": { "path": "/", "summary": ["version", "mode"] },
  "hooks": { "release": [{ "action": "stop" }] },
  "actions": {
    "status": { "method": "GET", "path": "/", "tier": "read" },
    "light": { "method": "GET", "path": "/led", "tier": "operate", "query": ["n"] },
    "stop": { "method": "GET", "path": "/stop", "tier": "operate" },
    "flash": { "method": "POST", "path": "/firmware", "tier": "approve", "body": "file" }
  }
}
\`\`\`

- \`tier\`: \`read\` runs without a lease; \`operate\` needs the lease; \`approve\` also waits for the
  user's approval, even in full-access threads. The user can allow once or for the rest of the
  lease. It runs only through \`hardware_call\` during a running turn, and fails after 10 minutes
  without an answer. Give anything destructive or hard to undo (firmware, reboot, erase)
  the \`approve\` tier.
- \`method\`: \`GET\`, \`POST\`, \`PUT\`, \`PATCH\` or \`DELETE\`. \`path\` is an absolute path with no query
  string; list allowed query parameter names in \`query\`. \`body: "file"\` sends a workspace file the
  caller names. \`description\` is optional.
- \`hooks\`: \`acquire\`, \`renew\` and \`release\` lists of \`{ "action", "query"?, "everySeconds"? }\`
  steps. \`action\` must name an action in the definition. \`everySeconds\` (10 to 3600, default 60)
  applies to renew steps only. Query values can use \`$lease.purpose\` and
  \`$lease.deviceTtlSeconds\`.
- When a lease ends, styal runs the release hooks accepted when it was granted, so use them to
  return the device to a safe state. If the device does not answer, styal retries for 10 minutes,
  and nobody can take the device until then. No hooks run until the user accepts the definition.
- \`deviceTtlSeconds\` (top-level, 30 to 3600, default 180) is the value of
  \`$lease.deviceTtlSeconds\`. Send it from acquire and renew hooks to keep a device-side timeout
  alive.
- \`health\`: a \`path\` polled for online state, with optional \`intervalSeconds\`, \`timeoutMs\` and
  \`summary\` (dotted paths into the JSON response).

styal reads the definition from the repository's default branch on \`origin\` (or local \`main\` or
\`master\` if there is no \`origin\`), so a change reaches other threads once it is merged and
fetched. styal fetches when a lease is acquired. A thread in a worktree also sees that worktree's
copy of the file: actions it adds or changes run at \`approve\`, and its hooks and health are
ignored. Propose changes in a pull request.

## What the user does

In Settings → Hardware the user adds the device (id, owning project, definition file name and
address reachable from the environment server, plus a token if the device checks one), reviews
and accepts the definition, and turns on **Agent hardware access**. Until a definition is accepted, every
action runs at \`approve\` and its hooks and health are not used. Until the user accepts a loosening
change, the accepted rules stay in force: a lowered tier keeps its accepted tier, a new or changed
action runs at \`approve\`, and changed hooks, health or \`deviceTtlSeconds\` keep their accepted
values. Stricter changes apply on merge. Agents never see the device token.
`;

const dataImport = `# Importing data

Imports run from the client, not through agent tools. Explain the steps and let the user run them.

## T3 Code projects, threads and preferences

Settings → Import data on web or desktop, or the setup wizard, imports from T3 Code's data in
\`~/.t3/userdata\` on each selected server. T3 Code can stay open. It brings projects, threads with
history and provider continuation, and optionally preferences. A new project comes with its scripts,
icon, instructions and defaults. A project styal already has keeps its own setup and gets only its
missing threads. Connections, provider sign-ins and credentials are not imported. If an import is
interrupted, completed threads stay imported, and choosing Import again continues with the rest. The
same page repairs threads imported by an affected older release.

After an import, a project that had a \`t3.json\` can move to \`styal.json\`; read the
\`project-setup\` guide.

## Claude Code and Codex history

Offered only in the setup wizard's project import step, not in Settings. The wizard opens by itself
on a new install. On web, opening \`/welcome\` runs it again.

## Browser sessions

The desktop app can copy cookies from another browser into a preview browser profile: Settings →
Browser → Browsing → Browser profiles → Add profile → **Import from**. Quit the source browser
first, except Safari, which can stay open but needs Full Disk Access on macOS. This is a one-time
copy.
`;

const troubleshooting = `# Troubleshooting a styal install

You run inside styal, so commands that stop or restart its server end your own session. Ask the
user before running any of them, and prefer read-only checks first.

The desktop app does not put \`styal\` on PATH. Its launcher is \`~/.styal/bin/styal\` (\`styal.cmd\` on
Windows) with the default data directory. Other installs have \`styal\`, or use
\`npx @styal/cli@nightly\`.

- \`styal service status\` reports whether the background service is installed.
- \`styal doctor --dry-run\` reports database size, reclaimable space and available repairs without
  changing anything. The repair is \`styal doctor\`, which prompts in a terminal, or
  \`styal doctor --fix\`, which runs only the recommended repairs. It stops an installed background
  service for the same data directory and starts it again afterwards, and it refuses to run while a
  server started by hand or the desktop app has the database open. The user should quit those and
  run it from a separate terminal. It needs free space of about the database size in the system
  temporary directory, and again next to the database.
- \`styal trace summary --since 30m\` lists spans by count, with p50, p90 and max durations, for
  slowness. It shows 25 by default; use \`--limit\` for more.
- To report a styal bug or send styal feedback when the user wants to, call \`report_styal_issue\`.
  It is for styal itself, not the user's project. It posts a public issue under the GitHub account
  signed in on this environment, only after the user approves the exact text, so leave out paths,
  secrets, private code and names. If it returns \`not_filed\`, give the user \`manualUrl\`. The user
  can also choose **Send feedback** in the command palette or Settings → About, or on mobile under
  Settings → Environments, on that environment.
- For crashes, sign-in failures or broken setups that need diagnosing, the user runs
  \`npx @styal/cli triage\` in a terminal outside styal. With \`claude\` or \`codex\` installed, it
  starts a separate agent session with a triage playbook and machine facts, and helps file an issue.
  Without either, it writes the prompt and context to files to paste into another agent.
- These commands use \`STYAL_HOME\` if set, otherwise \`~/.styal\`. Your shell does not inherit the
  server's \`STYAL_HOME\`, so pass \`--base-dir\` when the server uses another data directory.

Provider problems (a CLI missing, signed out or outdated) show in Settings → Providers.
`;

export const AGENT_GUIDES: Readonly<Record<AgentGuideTopic, string>> = {
  "project-setup": projectSetup,
  devices,
  hardware,
  "data-import": dataImport,
  troubleshooting,
};
