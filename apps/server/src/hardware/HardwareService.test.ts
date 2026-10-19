import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type HardwareDefinition,
  type HardwareDeviceConfig,
  HardwareDeviceId,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ProviderApprovalDecision,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { runAllMigrations } from "../persistence/ForkMigrations.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { VcsProcess } from "../vcs/VcsProcess.ts";
import * as HardwareService from "./HardwareService.ts";
import * as HardwareStore from "./HardwareStore.ts";

const PROJECT = ProjectId.make("project-tree");
const TREE = HardwareDeviceId.make("tree");
const CALIBRATOR = ThreadId.make("thread-calibrator");
const FIRMWARE = ThreadId.make("thread-firmware");

const definition: HardwareDefinition = {
  type: "tree",
  name: "Christmas tree",
  health: { path: "/", summary: ["version"] },
  hooks: {
    acquire: [{ action: "maintenance.start", query: { reason: "$lease.purpose" } }],
    release: [{ action: "calibrate.stop" }],
  },
  actions: {
    status: { method: "GET", path: "/", tier: "read" },
    "maintenance.start": {
      method: "POST",
      path: "/maintenance/start",
      tier: "operate",
      query: ["reason"],
    },
    "calibrate.led": { method: "GET", path: "/calibrate/led", tier: "operate", query: ["n"] },
    "calibrate.stop": { method: "GET", path: "/calibrate/stop", tier: "operate" },
    reboot: { method: "POST", path: "/reboot", tier: "approve" },
  },
};

const device: HardwareDeviceConfig = {
  id: TREE,
  projectId: PROJECT,
  definitionFile: "tree.json",
  baseUrl: "http://tree.test:8080",
  acceptedDefinition: definition,
};

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly authorization: string | undefined;
}

const shellFor = (id: ThreadId, title: string, busy: boolean): OrchestrationV2ThreadShell =>
  // The service reads only these fields of a thread shell.
  ({
    id,
    projectId: PROJECT,
    title,
    worktreePath: null,
    activeRunId: busy ? "run-1" : null,
    pendingBackgroundTasks: [],
    deletedAt: null,
    archivedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

const activeRun = {
  id: "run-1",
  status: "running",
  ordinal: 1,
  rootNodeId: "node-root",
} as unknown as OrchestrationV2Run;

/** A fake world: the device, git, threads and their approval cards. */
const makeHarness = Effect.gen(function* () {
  const sent: Sent[] = [];
  const online = yield* Ref.make(true);
  const shells = yield* Ref.make(
    new Map<ThreadId, OrchestrationV2ThreadShell>([
      [CALIBRATOR, shellFor(CALIBRATOR, "Calibrate front angle", true)],
      [FIRMWARE, shellFor(FIRMWARE, "Firmware rewrite", true)],
    ]),
  );
  const requests = yield* Ref.make<ReadonlyArray<OrchestrationV2RuntimeRequest>>([]);
  /** The definition on the repository's default branch. */
  const main = yield* Ref.make<HardwareDefinition>(definition);
  /** Threads whose running turn has ended. */
  const endedRuns = new Set<ThreadId>();
  const dispatched: OrchestrationV2InternalCommand[] = [];
  const secrets = new Map<string, Uint8Array>();

  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      sent.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        authorization: request.headers["authorization"],
      });
      if (!(yield* Ref.get(online))) {
        return HttpClientResponse.fromWeb(request, new Response("down", { status: 503 }));
      }
      return HttpClientResponse.fromWeb(
        request,
        url.pathname === "/"
          ? Response.json({ version: "3f2a1c" })
          : new Response("ok", { status: 200 }),
      );
    }),
  );

  const vcs = VcsProcess.of({
    run: (input) =>
      Effect.map(Ref.get(main), (current) => ({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout:
          input.args[0] === "show"
            ? JSON.stringify(current)
            : input.args[0] === "symbolic-ref"
              ? "origin/main\n"
              : "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      })),
  });

  const threads = {
    getThreadShell: (threadId: ThreadId) =>
      Effect.map(Ref.get(shells), (map) => map.get(threadId) ?? null),
    getThreadRecords: (threadId: ThreadId) =>
      Effect.map(Ref.get(requests), (runtimeRequests) => ({
        runs: [endedRuns.has(threadId) ? { ...activeRun, status: "completed" } : activeRun],
        runtimeRequests,
      })),
    dispatch: (command: OrchestrationV2InternalCommand) =>
      Effect.gen(function* () {
        dispatched.push(command);
        if (command.type === "server_approval.record" && command.approvalStatus === "pending") {
          yield* Ref.update(requests, (current) => [
            ...current,
            {
              id: command.requestId,
              nodeId: command.nodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "permission",
              status: "pending",
              responseCapability: { type: "server" },
              createdAt: DateTime.makeUnsafe(0),
              resolvedAt: null,
            } satisfies OrchestrationV2RuntimeRequest,
          ]);
        }
        return {} as never;
      }),
    // The service uses only the three methods above.
  } as unknown as ThreadManagementService.ThreadManagementService["Service"];

  const projects = {
    getById: () => Effect.succeed(Option.some({ workspaceRoot: "/repo/tree" })),
  } as unknown as ProjectService.ProjectService["Service"];

  const secretStore = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  });

  // Shared by every service instance, so a restart keeps the settings, as on disk.
  const settings = Context.get(
    yield* Layer.build(
      ServerSettings.layerTest({ hardwareDevices: [device], enableAgentHardwareAccess: true }),
    ),
    ServerSettings.ServerSettingsService,
  );

  const dependencies = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(VcsProcess, vcs),
    Layer.succeed(ThreadManagementService.ThreadManagementService, threads),
    Layer.succeed(ProjectService.ProjectService, projects),
    Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore),
    Layer.succeed(ServerSettings.ServerSettingsService, settings),
    ServerConfig.layerTest(process.cwd(), { prefix: "styal-hardware-test-" }),
  );

  /** A service instance; building another on the same database is a server restart. */
  const start = HardwareService.make.pipe(Effect.provide(dependencies));

  /** The user answering the newest approval card. */
  const answer = (decision: ProviderApprovalDecision) =>
    Ref.update(requests, (current) =>
      current.map((request, index) =>
        index === current.length - 1
          ? {
              ...request,
              status: "resolved" as const,
              decision,
              resolvedAt: DateTime.makeUnsafe(1),
            }
          : request,
      ),
    );

  const setBusy = (threadId: ThreadId, busy: boolean) =>
    Ref.update(shells, (map) => {
      const current = map.get(threadId)!;
      return new Map(map).set(threadId, shellFor(threadId, current.title, busy));
    });

  const endRun = (threadId: ThreadId) => Effect.sync(() => void endedRuns.add(threadId));
  const count = (method: string, path: string) =>
    sent.filter((request) => request.method === method && request.path === path).length;
  const approvalsOpened = () =>
    dispatched.filter(
      (command) =>
        command.type === "server_approval.record" && command.approvalStatus === "pending",
    ).length;

  return {
    sent,
    online,
    dispatched,
    start,
    answer,
    setBusy,
    secrets,
    main,
    settings,
    endRun,
    count,
    approvalsOpened,
  };
});

/** Each test gets its own database, so leases never leak between tests. */
const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* runAllMigrations();
    return yield* effect;
  }).pipe(
    Effect.scoped,
    Effect.provide(
      HardwareStore.layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const paths = (sent: ReadonlyArray<Sent>) =>
  sent.map((request) => `${request.method} ${request.path}${request.query}`);

describe("HardwareService", () => {
  it.effect("gives one thread the lease, queues the next, and cleans up on release", () =>
    withDatabase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const hardware = yield* harness.start;

        yield* hardware.acquire(CALIBRATOR, { device: TREE, purpose: "front angle" });
        expect(paths(harness.sent)).toContain("POST /maintenance/start?reason=front+angle");

        const refused = yield* hardware
          .acquire(FIRMWARE, { device: TREE, purpose: "flash" })
          .pipe(Effect.flip);
        expect(refused.code).toBe("busy");
        expect(refused.reason).toContain("Calibrate front angle");

        const waiting = yield* hardware
          .acquire(FIRMWARE, { device: TREE, purpose: "flash", wait: true })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        expect((yield* hardware.state).devices[0]?.queue.map((entry) => entry.threadId)).toEqual([
          FIRMWARE,
        ]);

        expect(yield* hardware.release(CALIBRATOR, TREE)).toEqual({ released: true });
        expect(paths(harness.sent)).toContain("GET /calibrate/stop");
        const granted = yield* Fiber.join(waiting);
        expect(granted.proxyBaseUrl).toMatch(/\/api\/hardware\/proxy\/[0-9a-f]{48}$/);
        expect((yield* hardware.state).devices[0]?.lease?.threadId).toBe(FIRMWARE);
      }),
    ),
  );

  it.effect("runs reads without a lease and refuses operate calls and unknown parameters", () =>
    withDatabase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const hardware = yield* harness.start;

        const status = yield* hardware.call(CALIBRATOR, { device: TREE, action: "status" });
        expect(status.body).toEqual({ version: "3f2a1c" });

        const notHeld = yield* hardware
          .call(CALIBRATOR, { device: TREE, action: "calibrate.led", query: { n: 3 } })
          .pipe(Effect.flip);
        expect(notHeld.code).toBe("not_held");

        yield* hardware.acquire(CALIBRATOR, { device: TREE, purpose: "front angle" });
        const badQuery = yield* hardware
          .call(CALIBRATOR, { device: TREE, action: "calibrate.led", query: { all: true } })
          .pipe(Effect.flip);
        expect(badQuery.code).toBe("invalid_request");

        yield* hardware.call(CALIBRATOR, {
          device: TREE,
          action: "calibrate.led",
          query: { n: 3 },
        });
        expect(paths(harness.sent)).toContain("GET /calibrate/led?n=3");
      }),
    ),
  );

  it.effect("asks the user before an approve action and remembers 'for this lease'", () =>
    withDatabase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const hardware = yield* harness.start;
        yield* hardware.acquire(FIRMWARE, { device: TREE, purpose: "flash" });

        const first = yield* hardware
          .call(FIRMWARE, { device: TREE, action: "reboot" })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        expect(paths(harness.sent)).not.toContain("POST /reboot");
        const opened = harness.dispatched.find(
          (command) =>
            command.type === "server_approval.record" && command.approvalStatus === "pending",
        );
        expect(opened?.type === "server_approval.record" && opened.prompt).toContain(
          '"reboot" on tree',
        );

        yield* harness.answer("acceptForSession");
        yield* TestClock.adjust("1 second");
        expect((yield* Fiber.join(first)).status).toBe(200);
        expect(paths(harness.sent)).toContain("POST /reboot");

        const approvalsBefore = harness.dispatched.length;
        yield* hardware.call(FIRMWARE, { device: TREE, action: "reboot" });
        expect(harness.dispatched.length).toBe(approvalsBefore);
      }),
    ),
  );

  it.effect("fails a declined approval without calling the device", () =>
    withDatabase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const hardware = yield* harness.start;
        yield* hardware.acquire(FIRMWARE, { device: TREE, purpose: "flash" });

        const call = yield* hardware
          .call(FIRMWARE, { device: TREE, action: "reboot" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* harness.answer("decline");
        yield* TestClock.adjust("1 second");
        expect((yield* Fiber.join(call)).code).toBe("approval_declined");
        expect(paths(harness.sent)).not.toContain("POST /reboot");
        expect(
          harness.dispatched.some(
            (command) =>
              command.type === "server_approval.record" && command.approvalStatus === "cancelled",
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("keeps the lease while the thread works and ends it after the idle time", () =>
    withDatabase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const hardware = yield* harness.start;
        yield* hardware.acquire(CALIBRATOR, {
          device: TREE,
          purpose: "front angle",
          idleMinutes: 5,
        });

        yield* TestClock.adjust("20 minutes");
        expect((yield* hardware.state).devices[0]?.lease?.threadId).toBe(CALIBRATOR);

        yield* harness.setBusy(CALIBRATOR, false);
        yield* TestClock.adjust("6 minutes");
        expect((yield* hardware.state).devices[0]?.lease).toBeNull();
        expect(paths(harness.sent)).toContain("GET /calibrate/stop");
      }),
    ),
  );

  it.effect("forwards proxied operate actions, refuses approve ones, and drops ended tokens", () =>
    withDatabase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const hardware = yield* harness.start;
        const { proxyBaseUrl } = yield* hardware.acquire(CALIBRATOR, {
          device: TREE,
          purpose: "front angle",
        });
        const token = proxyBaseUrl.split("/").at(-1)!;

        const led = yield* hardware.proxy({
          token,
          method: "GET",
          path: "/calibrate/led",
          query: [["n", "7"]],
        });
        expect(led.status).toBe(200);
        expect(paths(harness.sent)).toContain("GET /calibrate/led?n=7");

        const reboot = yield* hardware.proxy({ token, method: "POST", path: "/reboot", query: [] });
        expect(reboot.status).toBe(403);

        yield* hardware.release(CALIBRATOR, TREE);
        const ended = yield* hardware.proxy({
          token,
          method: "GET",
          path: "/calibrate/led",
          query: [["n", "8"]],
        });
        expect(ended.status).toBe(410);
      }),
    ),
  );

  it.effect("sends the stored credential and keeps leases across a restart", () =>
    withDatabase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const first = yield* harness.start;
        yield* first.configure({ type: "set-credential", deviceId: TREE, value: "device-token" });
        yield* first.acquire(CALIBRATOR, { device: TREE, purpose: "front angle" });
        expect(harness.sent.at(-1)?.authorization).toBe("Bearer device-token");

        const restarted = yield* harness.start;
        const lease = (yield* restarted.state).devices[0]?.lease;
        expect(lease?.threadId).toBe(CALIBRATOR);
        expect(lease?.purpose).toBe("front angle");
      }),
    ),
  );

  it.effect("asks again when an action approved for the lease changes shape", () =>
    withDatabase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const hardware = yield* harness.start;
        yield* hardware.acquire(FIRMWARE, { device: TREE, purpose: "flash" });
        const first = yield* hardware
          .call(FIRMWARE, { device: TREE, action: "reboot" })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* harness.answer("acceptForSession");
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(first);

        // The default branch points `reboot` somewhere else; the old approval must not cover it.
        yield* Ref.set(harness.main, {
          ...definition,
          actions: {
            ...definition.actions,
            reboot: { method: "POST", path: "/reboot-now", tier: "approve" },
          },
        });
        yield* TestClock.adjust("61 seconds");
        const second = yield* hardware
          .call(FIRMWARE, { device: TREE, action: "reboot" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("1 second");
        expect(harness.approvalsOpened()).toBe(2);
        yield* harness.answer("decline");
        yield* TestClock.adjust("1 second");
        expect((yield* Fiber.join(second)).code).toBe("approval_declined");
        expect(harness.count("POST", "/reboot-now")).toBe(0);
      }),
    ),
  );

  it.effect("drops a call whose lease ended while its approval waited", () =>
    withDatabase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const hardware = yield* harness.start;
        yield* hardware.acquire(FIRMWARE, { device: TREE, purpose: "flash" });
        const call = yield* hardware
          .call(FIRMWARE, { device: TREE, action: "reboot" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* hardware.control({ type: "revoke", deviceId: TREE });
        yield* hardware.acquire(FIRMWARE, { device: TREE, purpose: "flash again" });
        yield* harness.answer("accept");
        yield* TestClock.adjust("1 second");
        expect((yield* Fiber.join(call)).code).toBe("not_held");
        expect(harness.count("POST", "/reboot")).toBe(0);
      }),
    ),
  );

  it.effect("keeps the device until the last lease's cleanup succeeds", () =>
    withDatabase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const hardware = yield* harness.start;
        yield* hardware.acquire(CALIBRATOR, { device: TREE, purpose: "front angle" });
        yield* Ref.set(harness.online, false);
        yield* hardware.release(CALIBRATOR, TREE);
        expect((yield* hardware.state).devices[0]).toMatchObject({ lease: null, cleaningUp: true });
        const refused = yield* hardware
          .acquire(FIRMWARE, { device: TREE, purpose: "flash" })
          .pipe(Effect.flip);
        expect(refused.reason).toContain("cleanup");

        yield* Ref.set(harness.online, true);
        yield* TestClock.adjust("31 seconds");
        expect((yield* hardware.state).devices[0]?.cleaningUp).toBe(false);
        const stops = harness.count("GET", "/calibrate/stop");
        yield* hardware.acquire(FIRMWARE, { device: TREE, purpose: "flash" });
        yield* TestClock.adjust("2 minutes");
        // The old lease's cleanup never runs again under the new holder.
        expect(harness.count("GET", "/calibrate/stop")).toBe(stops);
      }),
    ),
  );

  it.effect("finishes an interrupted cleanup after a restart", () =>
    withDatabase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* harness.start;
            yield* first.acquire(CALIBRATOR, { device: TREE, purpose: "front angle" });
            yield* Ref.set(harness.online, false);
            yield* first.release(CALIBRATOR, TREE);
          }),
        );
        yield* Ref.set(harness.online, true);
        const restarted = yield* harness.start;
        yield* TestClock.adjust("1 second");
        expect(harness.count("GET", "/calibrate/stop")).toBeGreaterThanOrEqual(2);
        expect((yield* restarted.state).devices[0]?.cleaningUp).toBe(false);
      }),
    ),
  );

  it.effect("cleans up when the device is removed or agent access is turned off", () =>
    withDatabase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const hardware = yield* harness.start;
        const { proxyBaseUrl } = yield* hardware.acquire(CALIBRATOR, {
          device: TREE,
          purpose: "front angle",
        });
        yield* harness.settings.updateSettings({ enableAgentHardwareAccess: false });
        yield* TestClock.adjust("16 seconds");
        expect(harness.count("GET", "/calibrate/stop")).toBe(1);
        const proxied = yield* hardware.proxy({
          token: proxyBaseUrl.split("/").at(-1)!,
          method: "GET",
          path: "/calibrate/led",
          query: [["n", "1"]],
        });
        expect(proxied.status).toBe(410);

        yield* harness.settings.updateSettings({ enableAgentHardwareAccess: true });
        yield* hardware.acquire(FIRMWARE, { device: TREE, purpose: "flash" });
        yield* harness.settings.updateSettings({ hardwareDevices: [] });
        yield* TestClock.adjust("16 seconds");
        expect(harness.count("GET", "/calibrate/stop")).toBe(2);
      }),
    ),
  );

  it.effect("does not grant a queued lease to a turn that has ended", () =>
    withDatabase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const hardware = yield* harness.start;
        yield* hardware.acquire(CALIBRATOR, { device: TREE, purpose: "front angle" });
        const waiting = yield* hardware
          .acquire(FIRMWARE, { device: TREE, purpose: "flash", wait: true })
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* harness.endRun(FIRMWARE);
        yield* hardware.release(CALIBRATOR, TREE);
        expect((yield* Fiber.join(waiting)).code).toBe("unavailable");
        expect((yield* hardware.state).devices[0]?.lease).toBeNull();
      }),
    ),
  );

  it.effect("counts the holder's reads as activity on its lease", () =>
    withDatabase(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const hardware = yield* harness.start;
        yield* hardware.acquire(CALIBRATOR, {
          device: TREE,
          purpose: "front angle",
          idleMinutes: 5,
        });
        yield* harness.setBusy(CALIBRATOR, false);
        yield* TestClock.adjust("4 minutes");
        yield* hardware.call(CALIBRATOR, { device: TREE, action: "status" });
        yield* TestClock.adjust("3 minutes");
        expect((yield* hardware.state).devices[0]?.lease?.threadId).toBe(CALIBRATOR);
      }),
    ),
  );
});
