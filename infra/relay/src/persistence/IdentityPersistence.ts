import * as Context from "effect/Context";

import type { Accounts } from "../auth/Accounts.ts";
import type { AuthSessions } from "../auth/AuthSessions.ts";
import type { DpopProofReplay } from "../auth/DpopProofs.ts";
import type { EmailSignInCodes } from "../auth/EmailSignInCodes.ts";

// These ports keep whole operations, including their transaction and cleanup boundaries.
export class AccountPersistence extends Context.Service<AccountPersistence, Accounts["Service"]>()(
  "t3code-relay/persistence/IdentityPersistence/AccountPersistence",
) {}

export class EmailPersistence extends Context.Service<
  EmailPersistence,
  EmailSignInCodes["Service"]
>()("t3code-relay/persistence/IdentityPersistence/EmailPersistence") {}

export class SessionPersistence extends Context.Service<
  SessionPersistence,
  AuthSessions["Service"]
>()("t3code-relay/persistence/IdentityPersistence/SessionPersistence") {}

export class ReplayPersistence extends Context.Service<
  ReplayPersistence,
  Pick<DpopProofReplay["Service"], "consume" | "pruneExpired">
>()("t3code-relay/persistence/IdentityPersistence/ReplayPersistence") {}
