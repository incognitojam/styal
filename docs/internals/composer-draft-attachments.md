# Composer draft attachments

Web and desktop drafts hold environment-scoped references to uploaded files. Legacy drafts and
stashes may still contain data URLs. Keep those bytes until the upload succeeds and the replacement
reference is durably written; a failed upload or storage write must leave the old copy recoverable. Stash migration uses separate upload jobs so it
cannot release a pending upload still owned by a composer draft.

Mobile keeps its own copies of picked and shared files until ownership transfers or the content is
removed. A background worker uploads them while the environment is connected and records each
upload on the draft. Sending reuses that upload, or uploads the local copy again if the server's
upload expired. Cleanup waits until every owner has hydrated and written durably; a read or decode
failure must never be treated as an empty owner set. Previews, thumbnail extraction, and share
copies hold a temporary reference until they finish, even when the attachment has been sent or
removed.
