#!/usr/bin/env bash
# Record one real sample, then sweep contextualStrings sizes over it.
#
#   ./record-test.sh                 record a new sample and test it
#   ./record-test.sh existing.aiff   re-test an existing recording
#
# One recording tested N ways, so the A/B is deterministic despite the audio
# being human.
#
# Run this from Terminal.app or iTerm. A terminal embedded in an app that lacks
# NSMicrophoneUsageDescription (T3 Code's own terminal) cannot be granted
# microphone access, and AVAudioEngine returns silence rather than an error.
set -euo pipefail

cd "$(dirname "$0")"
bin=./.build/debug/t3-dictate
audio="${1:-/tmp/dictation-human.aiff}"
vocab=/tmp/vocab-human.txt

swift build >/dev/null

# Repo identifiers, plus the nonsense words from test-script.txt line 6 pinned
# at the front so they are present at every --limit.
printf 'Zyglorp\nFnorbulator\nQuastrix\n' > "$vocab"
./extract-vocab.sh ../.. 2000 >> "$vocab"

if [ $# -eq 0 ]; then
  echo
  echo "microphone: $("$bin" info 2>/dev/null | jq -r .microphoneAuthorization)"
  echo
  echo "Read test-script.txt aloud. Press Enter here when you're done."
  echo
  # Exits non-zero on denied permission or a silent recording.
  "$bin" record --out "$audio"
fi

echo
echo "=== transcripts ==="
run() {
  local label="$1"; shift
  local stderr_file output
  stderr_file=$(mktemp)
  if output="$("$bin" file --input "$audio" "$@" 2>"$stderr_file")"; then
    printf '%-18s %s\n' "$label" "$(printf '%s' "$output" | jq -r .text)"
  else
    printf '%-18s FAILED — %s\n' "$label" "$(tail -1 "$stderr_file")"
  fi
  rm -f "$stderr_file"
}

run "no vocab"
run "vocab 50"       --vocab "$vocab" --limit 50
run "vocab 500"      --vocab "$vocab" --limit 500
run "vocab 2003"     --vocab "$vocab"
run "no vocab +fast" --fast
run "vocab 500+fast" --vocab "$vocab" --limit 500 --fast

echo
echo "=== identical? (if all hashes match, contextualStrings did nothing) ==="
for args in "" "--vocab $vocab --limit 50" "--vocab $vocab --limit 500" "--vocab $vocab"; do
  # shellcheck disable=SC2086
  "$bin" file --input "$audio" $args 2>/dev/null | jq -r .text | shasum | cut -c1-12
done

echo
echo "sample kept at $audio"
