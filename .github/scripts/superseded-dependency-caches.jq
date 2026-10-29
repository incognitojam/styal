# Input is gh api --paginate --slurp output; $current is main's dependency hash.
# Older commits can re-save old generations later, so timestamps cannot identify
# the current generation. Leave slots without a current entry untouched.
[.[].actions_caches[]
 | select(.ref == "refs/heads/main")
 | . as $cache
 | (.key | capture("^(?<host>installed-deps-v1-.+)-(?<dependency>[a-f0-9]{64})-(?<filter>[a-f0-9]{64})$")?) as $slot
 | $cache + {slot: ($slot.host + "-" + $slot.filter), dependency: $slot.dependency}]
| group_by(.slot)[]
| select(any(.dependency == $current))
| .[]
| select(.dependency != $current)
| {id, key, size_in_bytes, created_at}
