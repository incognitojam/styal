#!/usr/bin/env bash

# Publishes the newest finished EAS production Android build as a GitHub
# release. EAS artifact links expire after two weeks; the release keeps the
# APK at a permanent public URL that Obtainium and the docs can point at.
# The android-update.json asset tells installed apps whether the release has a
# different runtime version, which over-the-air updates cannot deliver; see
# apps/mobile/src/features/updates/native-app-updates.ts.
#
# Safe to rerun: a build that already has a published release is left alone,
# and a draft left by an interrupted run is replaced.
#
# Tags are android-<version>-<versionCode>, and releases are created with
# --latest=false so they never take Latest from a stable v<semver> release.
# Until the first stable release exists, GitHub still reports the newest one as
# Latest. The CLI installers and the release workflows look only for v<semver>
# tags.
#
# Environment: EXPO_TOKEN, EXPO_OWNER, EXPO_PROJECT_ID, GH_TOKEN,
# GITHUB_REPOSITORY, RUNNER_TEMP, ANDROID_HOME, ANDROID_SIGNING_CERT_SHA256.
# DRY_RUN=1 verifies the APK and stops before creating the release.
set -euo pipefail

work="${RUNNER_TEMP:?}/android-release"
rm -rf "$work"
mkdir -p "$work/eas-project" "$work/assets"

# eas-cli reads the project ID from an Expo project. apps/mobile/app.config.ts
# imports workspace packages, so loading it would mean installing the mobile
# app's dependencies on every hourly run; a stub project needs nothing.
jq -n --arg owner "$EXPO_OWNER" --arg id "$EXPO_PROJECT_ID" \
  '{expo: {name: "styal", slug: "styal", owner: $owner, extra: {eas: {projectId: $id}}}}' \
  > "$work/eas-project/app.json"
echo '{}' > "$work/eas-project/eas.json"
echo '{"private": true}' > "$work/eas-project/package.json"

build="$(
  cd "$work/eas-project"
  eas build:list --platform android --build-profile production --status finished \
    --limit 1 --json --non-interactive | jq -e '.[0]'
)"
version="$(jq -r '.appVersion' <<< "$build")"
code="$(jq -r '.appBuildVersion' <<< "$build")"
commit="$(jq -r '.gitCommitHash' <<< "$build")"
url="$(jq -r '.artifacts.buildUrl' <<< "$build")"
build_id="$(jq -r '.id' <<< "$build")"
runtime_version="$(jq -r '.runtime.version' <<< "$build")"

if ! [[ "$version" =~ ^[0-9]+(\.[0-9]+)*$ && "$code" =~ ^[0-9]+$ && "$commit" =~ ^[0-9a-f]{40}$ && "$url" == https://*.apk && "$runtime_version" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Unexpected build metadata for EAS build $build_id:" >&2
  jq '{appVersion, appBuildVersion, gitCommitHash, runtime, artifacts}' <<< "$build" >&2
  exit 1
fi

tag="android-${version}-${code}"
if gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${tag}" --silent 2> /dev/null; then
  echo "Release ${tag} is already published."
  exit 0
fi

apk_name="styal-android-${version}-${code}.apk"
apk="$work/assets/$apk_name"
echo "Downloading EAS build ${build_id} (${version}, build ${code})."
curl -fsSL --retry 3 -o "$apk" "$url"

build_tools="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"

# Android installs an update only when it carries the same signer as the
# installed app, so an APK from any other key is useless to existing users.
signers="$(
  "$build_tools/apksigner" verify --print-certs "$apk" \
    | sed -nE 's/.*certificate SHA-256 digest: ([0-9a-f]{64})$/\1/p' \
    | sort -u
)"
if [[ "$signers" != "$ANDROID_SIGNING_CERT_SHA256" ]]; then
  printf 'APK signer does not match the production certificate.\nExpected: %s\nFound:\n%s\n' \
    "$ANDROID_SIGNING_CERT_SHA256" "$signers" >&2
  exit 1
fi

expected_package="package: name='build.styal.app' versionCode='${code}' versionName='${version}'"
badging="$("$build_tools/aapt2" dump badging "$apk")"
if [[ "$badging" != *"$expected_package"* ]]; then
  echo "APK package does not match EAS metadata; expected: ${expected_package}" >&2
  exit 1
fi

jq -n --arg version "$version" --argjson versionCode "$code" --arg runtimeVersion "$runtime_version" \
  --arg apk "$apk_name" --argjson apkSizeBytes "$(stat -c %s "$apk")" \
  '{$version, $versionCode, $runtimeVersion, $apk, $apkSizeBytes}' \
  > "$work/assets/android-update.json"
(cd "$work/assets" && sha256sum "$apk_name" android-update.json > SHA256SUMS)

cat > "$work/notes.md" << EOF
styal for Android ${version} (build ${code}). Requires Android 7.0 or newer.

Open \`${apk_name}\` on your device to install it, or to update an existing installation. Smaller updates arrive inside the app between releases.
EOF

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "Dry run: would publish ${tag} at ${commit} with:"
  cat "$work/assets/SHA256SUMS" "$work/assets/android-update.json" "$work/notes.md"
  exit 0
fi

# gh creates a release with assets as a draft and publishes it after the
# uploads, so an interrupted run leaves a draft. Drafts have no tag yet and the
# by-tag lookup above cannot see them.
gh api --paginate "repos/${GITHUB_REPOSITORY}/releases?per_page=100" \
  | jq -r --arg tag "$tag" '.[] | select(.draft and .tag_name == $tag) | .id' \
  | while read -r stale; do
    echo "Deleting draft release ${stale} left by an earlier run."
    gh api -X DELETE "repos/${GITHUB_REPOSITORY}/releases/${stale}"
  done

gh release create "$tag" "$apk" "$work/assets/android-update.json" "$work/assets/SHA256SUMS" \
  --repo "$GITHUB_REPOSITORY" \
  --target "$commit" \
  --title "styal for Android ${version} (${code})" \
  --notes-file "$work/notes.md" \
  --latest=false

echo "Published ${tag}."
