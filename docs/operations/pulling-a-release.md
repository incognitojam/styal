# Pulling a bad release

Pulling a release stops installs that have not taken it yet from updating to it. It does nothing
for installs already on it: those only move off it through a newer release. Rolling forward is
always part of the fix; pulling only narrows how many installs take the bad release before then.

## When to pull

Pull when installing the release does harm that a later release cannot undo:

- It loses or corrupts stored data, or runs a one-time pass over stored data that needed a
  follow-up the release does not contain.
- An install that takes it cannot start, or cannot update further.
- It has a security problem, such as exposed credentials or a bypassed permission check.

Roll forward without pulling when the next release repairs everything the bad one did: crashes,
broken UI, provider behaviour, or anything that does not persist.

Do nothing when the defect is cosmetic and the next routine nightly carries the fix.

### Hotfix or pull

A newer release replaces a bad one that a desktop app has downloaded but not installed. The app
keeps checking every 4 minutes with a download waiting, downloads the newer release, and discards
the old download; on macOS it also removes the staged update first. Pulling cannot do that: with
the bad release gone, the feed shows an older version, the app finds no update, and it installs
the download it already has on the next quit. So the hotfix is what protects anyone who already
downloaded the bad release, and pulling only protects apps that have not checked yet.

A desktop app installs its download when it quits or the user chooses **Restart to update**, and
on macOS at any exit once the update is staged. Nothing installs on launch or while idle.
Background services and linked servers update only when someone runs `styal update` or uses the
update button; they never update on their own.

A fix reaches a published nightly 17–30 minutes after it merges (Fork CI takes 5–8 minutes,
Fork Nightly 11–21). A pull takes about five minutes.

- The fix can merge now: merge it. That is enough for the desktop app. Pull as well only if
  the 17–30 minute wait matters for a permanent harm.
- No fix is ready, and the harm is permanent: pull now, then ship the fix as soon as it is ready.
  Until then, apps that already downloaded the bad release install it when they quit.
- The harm is not permanent: roll forward.

## How installs find a release

| Surface                               | Where the version comes from                                                                                           | After a pull                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop, Nightly track                | Newest `-nightly.` entry in `releases.atom`, then that release's `nightly*.yml`                                        | Falls back to the previous nightly. Never downgrades. A download already made still installs on quit until a newer release replaces it. |
| Desktop, Stable track                 | The release marked Latest, then its `latest*.yml`                                                                      | Follows Latest.                                                                                                                         |
| `styal update`, mobile server updates | `@styal/cli` npm dist-tag, offered only if the release's `SHA256SUMS` downloads                                        | Follows the dist-tag. Refuses to go below the installed version without `--allow-downgrade`.                                            |
| `npx @styal/cli@<tag or version>`     | npm, then that version's archive from the GitHub Release                                                               | Fails to download a drafted release.                                                                                                    |
| Update everything, remote updates     | The version the desktop app is installing, or the web app's version; a service downloads that archive from the release | A drafted release fails as "not available"; a version already on disk still installs.                                                   |
| Mobile                                | EAS Update on merge to `main`; Android APKs from `android-*` releases                                                  | Not tied to nightly or stable releases. Roll forward with a revert on `main`.                                                           |
| Web app and relay                     | Deploy on push to `main`                                                                                               | Not tied to releases. Roll forward with a revert on `main`.                                                                             |
| Pull request previews                 | One rolling prerelease with no update feed                                                                             | Unaffected.                                                                                                                             |

Sources: [`DesktopUpdates.ts`](../../apps/desktop/src/updates/DesktopUpdates.ts),
[`resolveGitHubPublishConfig`](../../scripts/build-desktop-artifact.ts),
[`cli/update.ts`](../../apps/server/src/cli/update.ts),
[`selfUpdate.ts`](../../apps/server/src/cloud/selfUpdate.ts).

## What each action does

| Action                                      | Use it   | Reversible | Effect                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Move the npm dist-tag to a good version     | Yes      | Yes        | `styal update` and `npx @styal/cli@<tag>` stop offering the bad version.                                                                                                                                                                                                                                     |
| Convert the GitHub release to a draft       | Yes      | Yes        | Leaves the desktop feeds and makes its assets unreachable, so exact-version installs fail. Fork Release's default source skips drafts.                                                                                                                                                                       |
| Mark the previous stable release Latest     | Stable   | Yes        | Desktop Stable feed points back at it.                                                                                                                                                                                                                                                                       |
| `npm deprecate`                             | Optional | Yes        | Prints a warning on install. Does not stop installs by dist-tag or exact version.                                                                                                                                                                                                                            |
| Delete the GitHub release                   | No       | No         | Same as a draft, but the assets are gone.                                                                                                                                                                                                                                                                    |
| Edit or remove `nightly*.yml`/`latest*.yml` | No       | No         | The feed still names the release, so every install on that track gets an update error instead.                                                                                                                                                                                                               |
| Delete or move the tag                      | No       | No         | Breaks the provider canary, which fetches the tag of every nightly npm published in the last seven days, and the next release's notes range. Deleting a stable tag drops nightlies back to that version's prerelease numbers, which sort below the installed stable, and lets Fork Release promote it again. |
| `npm unpublish`                             | No       | No         | The version can never be published again, and anything pinned to it, including the canary, fails.                                                                                                                                                                                                            |

## Pull a nightly

Moving the dist-tag needs an npm login with publish rights on `@styal/cli`; CI's trusted publishing
does not cover it. Set the versions first:

```sh
export GH_REPO=incognitojam/styal
BAD=0.1.1-nightly.20261112.1366   # repeat steps 2–3 for each bad nightly
GOOD=0.1.1-nightly.20261112.1362  # newest nightly without the defect
```

1. If `main` still contains the bad change, stop the next merge from publishing it again:

   ```sh
   gh workflow disable fork-nightly.yml
   ```

   Verify: `gh workflow list --all` shows Fork Nightly as `disabled_manually`.

2. Move the dist-tag before drafting the release, so `npx @styal/cli@nightly` never resolves to an
   archive that cannot be downloaded:

   ```sh
   npm dist-tag add @styal/cli@$GOOD nightly
   ```

   Verify: `npm view @styal/cli dist-tags` shows `nightly: $GOOD`.

3. Draft the release:

   ```sh
   gh release edit v$BAD --draft
   ```

   Verify:
   - `gh release view v$BAD --json isDraft` is `true`.
   - `curl -sI https://github.com/incognitojam/styal/releases/download/v$BAD/SHA256SUMS` is `404`.
   - `curl -s https://github.com/incognitojam/styal/releases.atom | grep -m1 -o 'tag/v[^"]*'`
     names `$GOOD` or a later good nightly. GitHub may serve the old feed for a few minutes.

4. Optionally, `npm deprecate @styal/cli@$BAD "<what is wrong; update to the next nightly>"`.

5. [Tell the people on it](#tell-people-on-the-bad-release).

Leave the tag and the `nightly` branch alone. The next nightly's upgrade test should start from the
pulled build's schema, because installs are running it.

## Pull a stable release

Stable releases publish only by hand, so nothing needs holding. With `PREV` the previous stable
version:

1. `npm dist-tag add @styal/cli@$PREV latest`. Verify with `npm view @styal/cli dist-tags`.
2. `gh release edit v$PREV --latest`. Verify:
   `gh api repos/incognitojam/styal/releases/latest --jq .tag_name` is `v$PREV`.
3. `gh release edit v$BAD --draft`. Verify as for a nightly, and that Latest is still `v$PREV`.

If there is no previous stable release to mark Latest, do not draft the release; roll forward.

## Tell people on the bad release

There is no in-app announcement. Put the instructions in the fix-forward release notes, which the
desktop app shows when it offers the update, and in whatever channel announced the release.
Say which versions are affected, what happened to their data, and what to do: update the desktop
app as usual, and run `styal update` on background services once the fix is published.

## What pulling does not do

- It does not move installs off the bad release. The desktop app never downgrades.
  `styal update --allow-downgrade` exists for services, but refuses when the database has changes
  the older release does not know, and a downgrade undoes nothing.
- It does not undo anything already applied to stored data: migrations, backfills, or a one-time
  pass that recorded itself as done. Fixing those needs code in the next release that finds and
  repairs them, for example a versioned done marker so a corrected pass runs again where the
  earlier one ran.
- It does not stop a desktop app that already downloaded the release from installing it on quit.
  Only a newer release replaces that download.
- It does not change mobile, the web app, or the relay.
- It does not fix a protocol change. If the bad release changed `ORCHESTRATION_PROTOCOL_VERSION`,
  machines on it cannot connect to machines on the previous release until the fix-forward ships.

## Afterwards

1. Merge the fix, with a repair for stored data where needed. If Fork Nightly was disabled, enable
   it and start a run, since a disabled workflow drops the CI completions that would have started
   it:

   ```sh
   gh workflow enable fork-nightly.yml
   gh workflow run fork-nightly.yml
   ```

   Verify the new nightly is published and `npm view @styal/cli dist-tags` shows it as `nightly`.

2. For a stable fix, promote a nightly that contains it. The pulled stable keeps its tag, so the
   fix ships as the next patch version, which nightlies after a stable release already carry. Name
   the source explicitly: `gh workflow run fork-release.yml -f source_tag=v<nightly with the fix>`.
3. Leave pulled releases as drafts and their tags in place. The provider canary needs no repair:
   it reads the `nightly` dist-tag and the tags of recent npm versions, so it verifies against the
   good nightly until the fix-forward is published.
4. The next release's notes list changes since the pulled tag. Installs that skipped the pulled
   release do not see its notes, so add anything they need to know with `gh release edit --notes-file`.

## Hold nightlies while a follow-up is in review

When a change that runs once over stored data has a known follow-up still in review, merge them
together, or disable Fork Nightly (`gh workflow disable fork-nightly.yml`) until both are on `main`,
then enable it and start a run as above. The intake landing hold blocks pull request merges, not
Fork Nightly.
