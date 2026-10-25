/**
 * The default branch may only tighten the accepted definition on its own; anything looser waits
 * for the user and runs at `approve` meanwhile. A worktree's copy may add endpoints, but never
 * below `approve` for anything the default branch does not already allow.
 */
import {
  type HardwareActionDefinition,
  type HardwareActionSummary,
  HardwareDefinition,
  type HardwareDefinitionChange,
  type HardwareTier,
  isLooserHardwareTier,
  stricterHardwareTier,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const decodeDefinitionJson = Schema.decodeUnknownExit(Schema.fromJsonString(HardwareDefinition));

/** Parses a definition file; the error is written for the user. */
export const parseDefinition = (
  text: string,
): { readonly definition: HardwareDefinition } | { readonly error: string } => {
  const exit = decodeDefinitionJson(text);
  return Exit.isSuccess(exit)
    ? { definition: exit.value }
    : { error: `The definition is not valid: ${String(exit.cause).slice(0, 500)}` };
};

/** Same request on the wire, whatever the tier. */
const sameShape = (a: HardwareActionDefinition, b: HardwareActionDefinition) =>
  a.method === b.method &&
  a.path === b.path &&
  a.body === b.body &&
  sortedKey(a.query) === sortedKey(b.query);

const sortedKey = (values: ReadonlyArray<string> | undefined) =>
  JSON.stringify([...(values ?? [])].toSorted());

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface EffectiveDefinition {
  readonly name: string;
  readonly actions: Readonly<Record<string, HardwareActionDefinition>>;
  /** Hook steps resolve against these: the accepted definitions, never unaccepted ones. */
  readonly hookActions: Readonly<Record<string, HardwareActionDefinition>>;
  readonly hooks: NonNullable<HardwareDefinition["hooks"]>;
  readonly health: HardwareDefinition["health"];
  readonly deviceTtlSeconds: number | undefined;
  readonly pendingChanges: ReadonlyArray<HardwareDefinitionChange>;
}

/**
 * The rules in force for a device: the default branch's definition, held back
 * to what the user accepted wherever it is looser.
 */
export const effectiveDefinition = (
  main: HardwareDefinition,
  accepted: HardwareDefinition | undefined,
): EffectiveDefinition => {
  const acceptedActions = accepted?.actions ?? {};
  const actions: Record<string, HardwareActionDefinition> = {};
  const pendingChanges: HardwareDefinitionChange[] = [];
  for (const [name, action] of Object.entries(main.actions)) {
    const previous = acceptedActions[name];
    if (previous === undefined) {
      actions[name] = { ...action, tier: "approve" };
      pendingChanges.push({ action: name, kind: "added", to: action.tier });
    } else if (!sameShape(previous, action)) {
      actions[name] = { ...action, tier: "approve" };
      pendingChanges.push({
        action: name,
        kind: "other",
        from: `${previous.method} ${previous.path}`,
        to: `${action.method} ${action.path}`,
      });
    } else {
      actions[name] = { ...action, tier: stricterHardwareTier(action.tier, previous.tier) };
      if (isLooserHardwareTier(action.tier, previous.tier)) {
        pendingChanges.push({
          action: name,
          kind: "loosened",
          from: previous.tier,
          to: action.tier,
        });
      }
    }
  }
  if (!sameJson(main.hooks, accepted?.hooks)) {
    pendingChanges.push({ action: "hooks", kind: "hooks-changed" });
  }
  if (
    !sameJson(main.health, accepted?.health) ||
    main.deviceTtlSeconds !== accepted?.deviceTtlSeconds
  ) {
    pendingChanges.push({ action: "health", kind: "other" });
  }
  // Removing an action is a tightening, so it is simply gone. Hooks and the
  // health probe run without asking anyone, so only accepted ones run.
  return {
    name: main.name,
    actions,
    hookActions: acceptedActions,
    hooks: accepted?.hooks ?? {},
    health: accepted?.health,
    deviceTtlSeconds: accepted?.deviceTtlSeconds,
    pendingChanges,
  };
};

/**
 * Applies a worktree's copy of the definition for threads in that worktree.
 * An action it adds or reshapes runs at `approve`; one it shares with the
 * effective definition can only get stricter.
 */
export const withWorktreeOverlay = (
  effective: Readonly<Record<string, HardwareActionDefinition>>,
  overlay: HardwareDefinition | undefined,
): Readonly<Record<string, HardwareActionDefinition>> => {
  if (overlay === undefined) return effective;
  const actions: Record<string, HardwareActionDefinition> = { ...effective };
  for (const [name, action] of Object.entries(overlay.actions)) {
    const current = effective[name];
    actions[name] =
      current !== undefined && sameShape(current, action)
        ? { ...current, tier: stricterHardwareTier(current.tier, action.tier) }
        : { ...action, tier: "approve" };
  }
  return actions;
};

export const summarizeActions = (
  actions: Readonly<Record<string, HardwareActionDefinition>>,
): ReadonlyArray<HardwareActionSummary> =>
  Object.entries(actions)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, action]) => ({
      name,
      method: action.method,
      path: action.path,
      tier: action.tier,
      query: action.query ?? [],
      ...(action.body === undefined ? {} : { body: action.body }),
      ...(action.description === undefined ? {} : { description: action.description }),
    }));

/** The action a proxied request maps to: same method and path. */
export const actionForRequest = (
  actions: Readonly<Record<string, HardwareActionDefinition>>,
  method: string,
  path: string,
): { readonly name: string; readonly action: HardwareActionDefinition } | undefined => {
  for (const [name, action] of Object.entries(actions)) {
    if (action.method === method && action.path === path) return { name, action };
  }
  return undefined;
};

/**
 * Checks a caller's query against what the action allows. Returns the
 * refused names, so the error can say which.
 */
export const refusedQueryKeys = (
  action: HardwareActionDefinition,
  keys: Iterable<string>,
): ReadonlyArray<string> => {
  const allowed = new Set(action.query ?? []);
  return [...keys].filter((key) => !allowed.has(key));
};

export type { HardwareTier };
