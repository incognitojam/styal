# Composer draft synchronization

Existing-thread composer drafts are high-churn current state, not orchestration history. The server
stores one JSON `common` section per thread with a monotonic revision and mutation ID. A null
`common` value is a durable tombstone, which prevents a stale revision-zero client from resurrecting
a sent draft.

Clients keep their existing local durable cache and subscribe to the server snapshot. Desktop uses
the web implementation; mobile starts its subscription only after its persisted local drafts hydrate.
Updates use revision compare-and-swap. A clean client applies newer server state; an actively edited
client waits for the idle debounce and retries once against a conflicting revision. On first contact,
an existing non-empty local cache is preserved rather than automatically overwriting an established
server draft.

The shared section contains text, model selection, runtime mode, and interaction mode. Attachment
bytes and surface-specific context never cross this channel. A client projects a draft containing
local-only context to a tombstone and refuses to apply remote state until that context is gone.

A turn-start command may carry the composer revision captured at send time. Mobile persists that
revision alongside an offline outbox message and forwards it when delivery eventually succeeds.
After the turn command is durably accepted, the server conditionally writes a tombstone at that
revision. This prevents a delayed send from erasing a newer edit from another client.
