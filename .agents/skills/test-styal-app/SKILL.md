---
name: test-styal-app
description: Test styal's web and desktop UI through its built-in Browser panel against isolated development state. Use for browser verification, browser pairing recovery, styal Link sign-in, and test fixtures. Use test-styal-mobile for native mobile verification.
---

# Test styal web and desktop

Use styal's built-in Browser panel for verification. A status with no tab
(`tabId: null`) means you should try `preview_open`, even when an older server
reports `available: false`. Do not stop on that empty status alone.
If the tools are absent, opening reports unsupported, or two panel attempts fail
at the same step, use headless Chromium through `playwright-core` against the same isolated dev server and disclose the
fallback. For native mobile testing, use
[test-styal-mobile](../test-styal-mobile/SKILL.md).

## Start the app

Reuse this task's healthy dev server. Otherwise run `T3CODE_DEV_SEED=0 vp run dev` from the
repository root and retain its terminal session. Use the worktree's ignored
`.styal` state and read the actual ports and pairing URL from the dev-runner output.
Never run against `~/.styal/userdata` or set `VITE_HTTP_URL` or `VITE_WS_URL`.

Test with meaningful project and thread data. Read
[references/sqlite-fixtures.md](references/sqlite-fixtures.md) only when
inspecting or seeding SQLite. Stop the test server before direct fixture writes.

## Use the Browser panel

Call `preview_status`. If no tab can be automated, call `preview_open`, including
when status reports `available: false` or `tabId: null`. Status can report
unavailable simply because no tab exists yet; opening a tab needs no user action.
Reuse an existing usable tab. Follow the fallback rules above only if opening
reports unsupported or two panel attempts fail at the same step.

Navigate to the complete startup pairing URL once with
`preview_navigate`, then use `preview_snapshot` and styal's interaction tools.
If the token was consumed or expired, run `node apps/server/src/bin.ts pair`
for a fresh one. Keep using the same tab.

## When the Browser panel cannot open

Use the existing `playwright-core` package and an installed Chromium executable.
Launch headless with a fresh browser context; keep any scripts, captures and
persistent test profile under the worktree's ignored `.scratch/`. Never attach
to a user's browser or reuse their profile. Use the same isolated server and
startup pairing URL, with synthetic fixtures and the origin rules above. Do
not point the fallback at an installed server or copy live state to make it work.
Inspect the affected flow, browser console and failed requests, and capture the
result. Close the headless browser you started when finished, and say in your
report that verification used a headless fallback.

## Sign in to styal Link

Link sign-in only appears when the dev server has a relay URL. If the root `.env` lacks one, export `.env.development.example` for the dev server: `set -a; . ./.env.development.example; set +a` before `vp run dev`. It points at the shared development relay, `relay-dev.styal.build`.

Use the shared agent account, `agent+clerk_test@styal.build`. Do not create other accounts.

- **Local dev (development relay):** open Settings and choose **Sign in to styal Link**. A fresh database shows the welcome wizard first; click through it. Enter the email, choose **Send code**, then enter the development relay's fixed test code: the value of the `RELAY_DEV_TEST_SIGN_IN_CODE` variable, which the maintainer sets. It only works while the dev relay uses log delivery (`RELAY_DEV_EMAIL_DELIVERY=log`); if sign-in says email sign-in is not available, those variables are not set, so ask the maintainer.
- **`app.styal.build` or other builds using the production relay:** there is no test code. Ask the maintainer for the code from the sign-in email, and keep it out of screenshots and logs. Sign out when done; signing out ends the session on the relay.

The sign-in dialog's selectors: scope dialog queries by name (`getByRole("dialog", { name: "Sign in to styal Link" })`), since the provider "Updates Available" toast is also a dialog.

## Verify and retain

Exercise the affected flow and capture the state that proves it works. Keep
the server, state, and panel available while the user inspects or iterates.
An assistant turn ending is not teardown. Stop only processes you started,
using retained terminal sessions or captured PIDs.

When sharing is requested, start with `vp run dev --share` and give the user
a fresh complete pairing URL that you have not consumed. Keep other credentials
out of screenshots, commits, and replies.
