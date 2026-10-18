import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";

// Sign-out clears environments, so the wizard opt-out must persist separately.
export const CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY = "styal:connect-onboarding-opt-out:v1";

export const ConnectOnboardingOptOutSchema = Schema.Struct({
  optOutAccounts: Schema.Array(Schema.String),
});

export type ConnectOnboardingOptOutState = typeof ConnectOnboardingOptOutSchema.Type;

export const EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE: ConnectOnboardingOptOutState = {
  optOutAccounts: [],
};

/** Emitted only after an interactive sign-in commits in this tab. */
export const interactiveRelaySignInAtom = Atom.make<{ readonly accountId: string } | null>(null);
