#!/usr/bin/env bash
# A/B the effect of contextualStrings at a range of vocabulary sizes.
#
#   ./ab-test.sh <audio-file> [vocab.txt]
#
# Prints one JSON line per configuration so runs can be diffed directly.
set -euo pipefail

audio="${1:?usage: ab-test.sh <audio-file> [vocab.txt]}"
vocab="${2:-/tmp/vocab-2000.txt}"
bin="$(dirname "$0")/.build/debug/t3-dictate"

run() {
  local label="$1"; shift
  printf '%-24s ' "$label" >&2
  "$bin" file --input "$audio" "$@" 2>/dev/null
}

run "baseline"
run "vocab-50"        --vocab "$vocab" --limit 50
run "vocab-200"       --vocab "$vocab" --limit 200
run "vocab-500"       --vocab "$vocab" --limit 500
run "vocab-2000"      --vocab "$vocab" --limit 2000
run "baseline+fast"   --fast
run "vocab-500+fast"  --vocab "$vocab" --limit 500 --fast
