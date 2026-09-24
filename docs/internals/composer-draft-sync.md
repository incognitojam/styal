# Composer draft synchronization

Existing-thread composer drafts are high-churn current state, not orchestration history. The server
stores one JSON `common` section per thread with a monotonic revision and mutation ID. A null
`common` value is a durable tombstone, which prevents a stale revision-zero client from resurrecting
a sent draft.

Clients keep their local durable cache and subscribe to the server snapshot; mobile subscribes only
after its persisted drafts hydrate. Updates use revision compare-and-swap. On first contact, an
existing non-empty local cache is not automatically overwritten by an established server draft.

The shared section contains text, model selection, runtime mode, and interaction mode. Attachment
bytes and surface-specific context never cross this channel. A client projects a draft containing
local-only context to a tombstone and refuses to apply remote state until that context is gone.

A turn-start command may carry the composer revision captured at send time, including from mobile's
offline outbox. After the turn command is durably accepted, the server tombstones the draft only at
that revision, so a delayed send cannot erase a newer edit from another client. The subscription
echo of a client's own latest update acknowledges the revision without replacing local content, so
it cannot restore text cleared by a send. The controller keeps that mutation ID after a transport
failure because the server may still have applied the write. A delayed response cannot roll back a
newer revision already received through the subscription.

## Attachment ownership

Web and desktop drafts hold environment-scoped references to uploaded files, outside the
synchronized `common` section. Legacy drafts and stashes may still contain data URLs. Keep those
bytes until the upload succeeds and the replacement reference is durably written; a failed upload or
storage write must leave the old copy recoverable. Stash migration uses separate upload jobs so it
cannot release a pending upload still owned by a composer draft.

Mobile keeps its own copies of picked and shared files until ownership transfers or the content is
removed. It uploads them at send time, and a retry can upload the local copy again if the server's
upload expired. Cleanup waits until every owner has hydrated and written durably; a read or decode
failure must never be treated as an empty owner set. Previews, thumbnail extraction, and share
copies hold a temporary reference until they finish, even when the attachment has been sent or
removed.
