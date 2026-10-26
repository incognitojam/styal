import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";

type Session = {
  _tag: "Success" | "Failure";
  waiting: boolean;
  value: { authenticated: boolean; permissions: string[] };
};
type Connection = { target: object };

const atoms = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  const OptionModule = await import("effect/Option");
  return {
    identities: Atom.make<ReadonlyArray<{ environmentId: string; label: string }>>([]).pipe(
      Atom.keepAlive,
    ),
    session: Atom.make<Session | null>(null).pipe(Atom.keepAlive),
    prepared: Atom.make(OptionModule.none<Connection>()).pipe(Atom.keepAlive),
  };
});
const state = vi.hoisted(() => ({
  id: 0,
  add: vi.fn((_notice: unknown) => "notice"),
  close: vi.fn(),
  navigate: vi.fn(),
  retired: false,
  current: null as Connection | null,
  retire: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: state.retired })),
}));
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSummaries: { ...actual.environmentSummaries, identitiesAtom: atoms.identities },
  } as never;
});
vi.mock(import("../state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: () => atoms.session,
      preparedConnectionValueAtom: () => atoms.prepared,
    },
    readPreparedConnection: () =>
      state.current ?? Option.getOrNull(appAtomRegistry.get(atoms.prepared)),
  } as never;
});
vi.mock(import("../connection/catalog"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentCatalog: { ...actual.environmentCatalog, retireLegacyPairing: null } as never,
  };
});
vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((_registry: unknown, _command: unknown, input: unknown) =>
    state.retire(input)) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: state.add, close: state.close } as never,
  };
});
import { appAtomRegistry } from "../rpc/atomRegistry";
import { startPermissionUpdateNotices } from "./PermissionUpdateNotice";

const storageKey = () => `t3code:permission-update:v1:env-${state.id}`;

function setPrepared(connection: Connection) {
  appAtomRegistry.set(atoms.prepared, Option.some(connection));
}

function setup(): Connection {
  state.id++;
  state.retired = false;
  state.current = null;
  vi.clearAllMocks();
  const connection = { target: {} };
  setPrepared(connection);
  appAtomRegistry.set(atoms.session, {
    _tag: "Success",
    waiting: false,
    value: { authenticated: true, permissions: ["orchestration:operate"] },
  });
  appAtomRegistry.set(atoms.identities, [
    { environmentId: `env-${state.id}`, label: "Work laptop" },
  ]);
  return connection;
}

function start(): Disposable {
  const stop = startPermissionUpdateNotices({ navigate: state.navigate } as never);
  return {
    [Symbol.dispose]: () => {
      stop();
      localStorage.clear();
    },
  };
}

async function settleChecks() {
  await Promise.all(state.retire.mock.results.map((result) => result.value));
}

it("drops an old pairing instead of warning when styal Link also reaches the environment", async () => {
  const connection = setup();
  state.retired = true;
  using _notices = start();
  await settleChecks();
  expect(state.retire).toHaveBeenCalledWith({
    environmentId: `env-${state.id}`,
    checked: connection,
  });
  expect(state.add).not.toHaveBeenCalled();
});

it("still tries to drop an old pairing whose notice was dismissed earlier", async () => {
  setup();
  localStorage.setItem(storageKey(), "true");
  using _notices = start();
  await settleChecks();
  expect(state.retire).toHaveBeenCalledTimes(1);
  expect(state.add).not.toHaveBeenCalled();
});

it("checks each new connection again but shows the notice once", async () => {
  setup();
  using _notices = start();
  await settleChecks();
  expect(state.add).toHaveBeenCalledTimes(1);
  setPrepared({ target: {} });
  await settleChecks();
  expect(state.retire).toHaveBeenCalledTimes(2);
  expect(state.add).toHaveBeenCalledTimes(1);
});

it("closes the notice when a later connection drops the pairing", async () => {
  setup();
  using _notices = start();
  await settleChecks();
  expect(state.add).toHaveBeenCalledTimes(1);
  state.retired = true;
  setPrepared({ target: {} });
  await settleChecks();
  expect(state.close).toHaveBeenCalledWith("notice");
  (state.add.mock.calls[0]![0] as { onClose: () => void }).onClose();
  expect(localStorage.getItem(storageKey())).toBeNull();
});

it("ignores a result for a connection that is no longer in use", async () => {
  setup();
  state.current = { target: {} };
  using _notices = start();
  await settleChecks();
  expect(state.retire).toHaveBeenCalledTimes(1);
  expect(state.add).not.toHaveBeenCalled();
});
