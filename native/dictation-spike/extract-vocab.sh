#!/usr/bin/env bash
# Pull the most frequent multi-word code identifiers out of a repo, most
# frequent first, for use as SpeechAnalyzer contextualStrings.
#
#   ./extract-vocab.sh [repo-path] [limit] > vocab.txt
#
# Only camelCase/PascalCase identifiers of 2+ words are emitted — single words
# are already in the system vocabulary, so biasing on them is wasted budget.
#
# No `pipefail`: `head` closes the pipe early by design, which SIGPIPEs `sort`.
set -eu

repo="${1:-.}"
limit="${2:-500}"

rg --no-filename --only-matching --no-line-number \
  -g '*.ts' -g '*.tsx' -g '*.rs' -g '*.swift' -g '*.go' \
  -g '!**/node_modules/**' -g '!**/dist/**' -g '!**/.build/**' \
  -g '!*.gen.ts' -g '!*.d.ts' \
  '\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b|\b(?:[A-Z][a-z0-9]+){2,}\b' \
  "$repo" \
  | sort \
  | uniq -c \
  | sort -rn \
  | head -n "$limit" \
  | awk '{print $2}'
