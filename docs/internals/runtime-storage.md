# Runtime storage ownership

styal and T3 Code are separate applications and must remain installable and runnable in parallel.
Every persistent client-side namespace owned by styal therefore uses a styal-specific name,
including local and session storage keys, cookies, IndexedDB databases, desktop partitions, mobile
secure-storage keys, native bundle identifiers, and mobile database files.

This boundary is intentionally a clean break rather than an in-place migration. styal must not
read, modify, or delete a T3 Code key or database. A first styal launch starts with fresh client
preferences and requires environments to be paired independently; an existing T3 Code install
keeps all of its state for its next launch. In particular, a T3 Code IndexedDB database that remains
in the same browser origin is not an orphan for styal to clean up.

The sole exception is the Styal-owned hosted web origin (`https://app.styal.build`). T3 Code used
that origin before the fork adopted its own storage namespace, so the hosted client performs a
one-time deletion of abandoned `t3code:*` local-storage keys and IndexedDB databases there. It never
runs that cleanup on localhost, the desktop protocol, or an arbitrary self-hosted origin, where the
old data may still belong to a parallel T3 Code installation.

Server state follows the same rule. styal defaults to `~/.styal`, worktree development defaults to
the worktree's `.styal`, and the explicit override is `STYAL_HOME`. Other inherited `T3CODE_*`
variables can remain where they configure protocol or development behavior rather than persistent
storage ownership. The service launcher accepts `T3CODE_HOME` only for an already-installed service
whose unit name is styal-specific, allowing that service to survive an upgrade without turning the
old variable into a general cross-application fallback.

Schema migrations within a styal-owned key or database are still allowed. Their source and target
must both belong to styal; a version suffix alone is not permission to reach into T3 Code storage.
