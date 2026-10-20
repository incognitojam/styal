import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

type Session = {
  _tag: "Success" | "Failure";
  waiting: boolean;
  value: { authenticated: boolean; permissions: string[] };
};
const state = vi.hoisted(() => ({
  id: 0,
  session: null as unknown as Session,
  add: vi.fn((_notice: unknown) => "notice"),
  close: vi.fn(),
  navigate: vi.fn(),
  retired: false,
  prepared: { target: {} },
  current: null as { target: object } | null,
  retire: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: state.retired })),
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.session) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [{ environmentId: `env-${state.id}`, label: "Work laptop" }],
  })) as never,
}));
vi.mock(import("../connection/catalog"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentCatalog: { ...actual.environmentCatalog, retireLegacyPairing: null } as never,
  };
});
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.retire) as never,
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  usePreparedConnection: (() => ({ _tag: "Some", value: state.prepared })) as never,
  readPreparedConnection: (() => state.current ?? state.prepared) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: state.add, close: state.close } as never,
  };
});
import { PermissionUpdateNotice } from "./PermissionUpdateNotice";

const storageKey = () => `t3code:permission-update:v1:env-${state.id}`;

function setup(): Disposable {
  state.id++;
  state.retired = false;
  state.prepared = { target: {} };
  state.current = null;
  state.session = {
    _tag: "Success",
    waiting: false,
    value: { authenticated: true, permissions: ["orchestration:operate"] },
  };
  vi.clearAllMocks();
  return { [Symbol.dispose]: () => localStorage.clear() };
}

type Notice = {
  timeout: number;
  actionProps: { onClick: () => void };
  data: { secondaryActionProps: { onClick: () => void } };
};
const notice = () => state.add.mock.calls[0]![0] as Notice;

it("keeps the notice visible and persists dismissal, with a route to pairing settings", async () => {
  using _state = setup();
  await using _screen = await render(<PermissionUpdateNotice />);
  expect(notice().timeout).toBe(0);
  expect(localStorage.getItem(storageKey())).toBeNull();
  notice().actionProps.onClick();
  expect(state.navigate).toHaveBeenCalledWith({ to: "/settings/connections" });
  expect(state.close).toHaveBeenCalledWith("notice");
  expect(localStorage.getItem(storageKey())).toBe("true");
});
it("does not repeat on session refresh or remount", async () => {
  using _state = setup();
  await using screen = await render(<PermissionUpdateNotice />);
  await screen.unmount();
  state.session = { ...state.session };
  await using _remounted = await render(<PermissionUpdateNotice />);
  expect(state.add).toHaveBeenCalledTimes(1);
});
it("skips a notice dismissed on an earlier launch", async () => {
  using _state = setup();
  localStorage.setItem(storageKey(), "true");
  await using _screen = await render(<PermissionUpdateNotice />);
  expect(state.add).not.toHaveBeenCalled();
});
it("waits for a successful, settled session check", async () => {
  using _state = setup();
  state.session._tag = "Failure";
  await using screen = await render(<PermissionUpdateNotice />);
  expect(state.add).not.toHaveBeenCalled();
  state.session = { ...state.session, _tag: "Success", waiting: true };
  await screen.rerender(<PermissionUpdateNotice />);
  expect(state.add).not.toHaveBeenCalled();
  state.session = { ...state.session, waiting: false };
  await screen.rerender(<PermissionUpdateNotice />);
  expect(state.add).toHaveBeenCalledTimes(1);
});
it("does not warn for a granular grant", async () => {
  using _state = setup();
  state.session.value.permissions.push("filesystem:read");
  await using _screen = await render(<PermissionUpdateNotice />);
  expect(state.add).not.toHaveBeenCalled();
});

it("persists the secondary dismissal without relying on the toast close callback", async () => {
  using _state = setup();
  await using _screen = await render(<PermissionUpdateNotice />);
  notice().data.secondaryActionProps.onClick();
  expect(localStorage.getItem(storageKey())).toBe("true");
  expect(state.close).toHaveBeenCalledWith("notice");
});

it("drops an old pairing instead of warning when T3 Connect also reaches the environment", async () => {
  using _state = setup();
  state.retired = true;
  await using _screen = await render(<PermissionUpdateNotice />);
  expect(state.retire).toHaveBeenCalledWith({
    environmentId: `env-${state.id}`,
    checked: state.prepared,
  });
  expect(state.add).not.toHaveBeenCalled();
});

it("still tries to drop an old pairing whose notice was dismissed earlier", async () => {
  using _state = setup();
  localStorage.setItem(storageKey(), "true");
  await using _screen = await render(<PermissionUpdateNotice />);
  expect(state.retire).toHaveBeenCalledTimes(1);
  expect(state.add).not.toHaveBeenCalled();
});

it("checks each new connection again but shows the notice once", async () => {
  using _state = setup();
  await using screen = await render(<PermissionUpdateNotice />);
  expect(state.add).toHaveBeenCalledTimes(1);
  state.prepared = { target: {} };
  await screen.rerender(<PermissionUpdateNotice />);
  expect(state.retire).toHaveBeenCalledTimes(2);
  expect(state.add).toHaveBeenCalledTimes(1);
});

it("closes the notice when a later connection drops the pairing", async () => {
  using _state = setup();
  await using screen = await render(<PermissionUpdateNotice />);
  expect(state.add).toHaveBeenCalledTimes(1);
  state.retired = true;
  state.prepared = { target: {} };
  await screen.rerender(<PermissionUpdateNotice />);
  expect(state.close).toHaveBeenCalledWith("notice");
  (state.add.mock.calls[0]![0] as { onClose: () => void }).onClose();
  expect(localStorage.getItem(storageKey())).toBeNull();
});

it("ignores a result for a connection that is no longer in use", async () => {
  using _state = setup();
  state.current = { target: {} };
  await using _screen = await render(<PermissionUpdateNotice />);
  expect(state.retire).toHaveBeenCalledTimes(1);
  expect(state.add).not.toHaveBeenCalled();
});
