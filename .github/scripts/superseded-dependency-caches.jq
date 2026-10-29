# Input is gh api --paginate --slurp output. Ignore cache access times:
# older commits can keep superseded dependency generations recently accessed.
[.[].actions_caches[]
 | select(.ref == "refs/heads/main")
 | . as $cache
 | (.key | capture("^(?<host>installed-deps-v1-.+)-(?<dependency>[a-f0-9]{64})-(?<filter>[a-f0-9]{64})$")?) as $slot
 | $cache + {slot: ($slot.host + "-" + $slot.filter), dependency: $slot.dependency}]
| group_by(.slot)[]
| . as $entries
| max_by(.created_at) as $newest
| $entries[]
| select(.id != $newest.id and .dependency != $newest.dependency and .created_at < $newest.created_at)
| {id, key, size_in_bytes, created_at}
