import {
  type DeviceError,
  type DeviceHostId,
  type DeviceId,
  type DevicePlatform,
  type DeviceSummary,
  DeviceToolUnavailableError,
  LOCAL_DEVICE_HOST_ID,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../../../config.ts";
import { ensureAgentDeviceShim } from "../../../device/AgentDeviceShim.ts";
import { nodeRuntimeUnavailableMessage } from "@t3tools/shared/nodeRuntime";

import { DeviceActivity } from "../../../device/DeviceIdle.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as DeviceFeatureUsage from "../../../telemetry/DeviceFeatureUsage.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DeviceScreenshotToolkit, DeviceStandardToolkit, DeviceToolkit } from "./tools.ts";

function agentDeviceTargetArgs(device: DeviceSummary): ReadonlyArray<string> {
  return device.platform === "ios"
    ? ["--platform", "ios", "--udid", device.id]
    : ["--platform", "android", "--serial", device.id];
}

export function agentDeviceQuickStart(
  device: DeviceSummary,
  targetArgs = agentDeviceTargetArgs(device),
  command = "agent-device",
  cloud = false,
): string {
  const executable = /^[a-zA-Z0-9_./:-]+$/.test(command)
    ? command
    : "'" + command.replaceAll("'", "'\"'\"'") + "'";
  const target = targetArgs
    .map((arg) =>
      /^[a-zA-Z0-9_./:-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\"'\"'") + "'",
    )
    .join(" ");
  const platformNotes = cloud
    ? "This is an EAS Simulator session in the cloud. It bills the Expo account per minute until it stops, so call device_close with shutdown: true when you are done. It starts with no apps installed: install-from-source <url> installs a build from a URL (iOS needs a .tar.gz containing a .app), and install uploads one from this machine."
    : device.platform === "ios"
      ? "First use builds an XCTest runner and can take a couple of minutes; later commands are fast."
      : "The Android snapshot helper installs itself on first use.";
  return [
    `The user is watching ${device.name} (${device.version}) in the Device panel.`,
    `Drive it with ${executable}. Use this exact executable path; login shells may reset PATH. Always pass ${target}.`,
    "Typical loop:",
    `  ${executable} open <bundle-or-package-id> ${target}     # or: open <app> <deep-link-url>`,
    `  ${executable} snapshot -i ${target}                     # accessibility tree with @eN refs`,
    `  ${executable} click @e3 ${target}`,
    `  ${executable} fill @e5 "text" ${target}`,
    `  ${executable} screenshot /tmp/shot.png ${target}        # or call device_screenshot`,
    `  ${executable} install <app> <path-to-.app-or-.apk> ${target}`,
    `Prefer snapshot refs over coordinates. Run ${executable} help for workflow guides and ${executable} <command> --help for flags.`,
    "Prefer agent-device for driving this device. simctl, adb, and xcrun remain available for anything it does not cover.",
    "For remote hosts, arrange builds, app installation, and any Metro reverse forwarding yourself. styal provides discovery, streaming, and control only.",
    "Keep the returned --config and --session flags on every command. Other hosts can be used concurrently; opening one does not switch these commands.",
    "Other agents may need devices. When you finish testing, hand it back with device_close; it stays booted for the next agent. While your turn is not running, another agent may take the device; commands then report that it was handed over, so call device_open again.",
    platformNotes,
  ].join("\n");
}

const requireDeviceAccess = McpInvocationContext.requireThreadMcpCapability("device").pipe(
  Effect.mapError(
    () =>
      new DeviceToolUnavailableError({
        reason: "Agent device access is turned off for this environment.",
      }),
  ),
);

type DeviceRef = { readonly hostId: DeviceHostId; readonly deviceId: DeviceId };

type ThreadDeviceRef = DeviceRef & { readonly threadId: ThreadId };

/**
 * Devices other threads have open, once per thread. `inUse` lists the sessions an
 * agent open must not take silently; see `DeviceActivity.inUse`.
 */
export function devicesOpenInOtherThreads(
  sessions: ReadonlyArray<ThreadDeviceRef>,
  inUse: ReadonlyArray<ThreadDeviceRef>,
  threadId: string,
): ReadonlyArray<ThreadDeviceRef & { readonly inUse: boolean }> {
  const key = (ref: ThreadDeviceRef) => JSON.stringify([ref.threadId, ref.hostId, ref.deviceId]);
  const used = new Set(inUse.map(key));
  const refs = new Map<string, ThreadDeviceRef & { readonly inUse: boolean }>();
  for (const session of sessions) {
    if (session.threadId === threadId) continue;
    refs.set(key(session), {
      hostId: session.hostId,
      deviceId: session.deviceId,
      threadId: session.threadId,
      inUse: used.has(key(session)),
    });
  }
  return [...refs.values()];
}

/** Devices other threads have open that an agent open would hand over. */
const reclaimableDevices = (open: ReadonlyArray<DeviceRef & { readonly inUse: boolean }>) =>
  open.filter(
    (ref) =>
      !open.some(
        (other) => other.inUse && other.hostId === ref.hostId && other.deviceId === ref.deviceId,
      ),
  );

const isListed = (refs: ReadonlyArray<DeviceRef>, device: DeviceSummary) =>
  refs.some((ref) => ref.hostId === device.hostId && ref.deviceId === device.id);

export const pickDevice = Effect.fn("handlers.pickDevice")(function* (
  devices: ReadonlyArray<DeviceSummary>,
  openInOtherThreads: ReadonlyArray<DeviceRef>,
  input: {
    readonly deviceId?: DeviceId | undefined;
    readonly platform?: DevicePlatform | undefined;
    readonly hostId?: DeviceHostId | undefined;
  },
): Effect.fn.Return<DeviceSummary, DeviceToolUnavailableError> {
  const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
  if (input.deviceId !== undefined) {
    const match = devices.find(
      (device) => device.hostId === hostId && device.id === input.deviceId,
    );
    if (match) return match;
    return yield* new DeviceToolUnavailableError({
      reason: `No device ${input.deviceId} on host ${hostId}. Call device_list for current ids.`,
    });
  }
  const candidates = devices.filter(
    (device) =>
      device.hostId === hostId &&
      (input.platform === undefined || device.platform === input.platform),
  );
  if (candidates.length === 0) {
    return yield* new DeviceToolUnavailableError({
      reason:
        input.platform === undefined
          ? "No simulators or emulators were found. Call device_list to see why."
          : `No ${input.platform} devices were found on host ${hostId}. Call device_list to see why.`,
    });
  }
  const platforms = new Set(candidates.map((device) => device.platform));
  if (input.platform === undefined && platforms.size > 1) {
    return yield* new DeviceToolUnavailableError({
      reason: "Both iOS and Android devices are available; pass platform or deviceId.",
    });
  }
  const booted = candidates.filter((device) => device.booted);
  const free = booted.find((device) => !isListed(openInOtherThreads, device));
  if (free) return free;
  if (booted.length > 0) {
    // Never take over another thread's device implicitly; its agent may be mid-run.
    return yield* new DeviceToolUnavailableError({
      reason: `Another thread is using ${booted.map((device) => `${device.name} (${device.id})`).join(", ")}. Pass deviceId: a stopped device from device_list to start it, or, if the user agrees, one of these with takeOver: true.`,
    });
  }
  return candidates[0]!;
});

const toolError = (error: DeviceError | DeviceToolUnavailableError) => error;

const handlers = {
  device_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      if (state.hostStatus === "disabled") {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.",
        });
      }
      const hostId = input?.hostId;
      const open = state.sessions
        .filter((session) => session.threadId === scope.thread.threadId)
        .map((session) => ({ hostId: session.hostId, deviceId: session.deviceId }));
      return {
        hostStatuses: Object.fromEntries(
          Object.entries(state.hostStatuses).filter(([id]) => !hostId || id === hostId),
        ),
        hosts: hostId ? state.hosts.filter((host) => host.id === hostId) : state.hosts,
        devices: hostId
          ? state.devices.filter((device) => device.hostId === hostId)
          : state.devices,
        open,
        openInOtherThreads: devicesOpenInOtherThreads(
          [...state.sessions, ...(state.externalSessions ?? [])],
          yield* (yield* DeviceActivity).inUse(scope.thread.threadId),
          scope.thread.threadId,
        ),
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_open: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      if (state.hostStatus === "disabled") {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.",
        });
      }
      const activity = yield* DeviceActivity;
      const openInOtherThreads = devicesOpenInOtherThreads(
        [...state.sessions, ...(state.externalSessions ?? [])],
        yield* activity.inUse(scope.thread.threadId),
        scope.thread.threadId,
      );
      const reclaimable = reclaimableDevices(openInOtherThreads);
      // Prefer a free device, then one a thread holds but is not using, then on a
      // take-over any device. The service refuses an in-use device without takeOver.
      const target = yield* pickDevice(state.devices, openInOtherThreads, input).pipe(
        Effect.catch((error) =>
          reclaimable.length === 0
            ? Effect.fail(error)
            : pickDevice(
                state.devices,
                openInOtherThreads.filter(
                  (ref) =>
                    !reclaimable.some(
                      (idle) => idle.hostId === ref.hostId && idle.deviceId === ref.deviceId,
                    ),
                ),
                input,
              ),
        ),
        Effect.catch((error) =>
          input.takeOver === true ? pickDevice(state.devices, [], input) : Effect.fail(error),
        ),
      );
      // Resolve consent and agent connectivity before booting or registering a session.
      if (!(yield* devices.agentReadinessIfSupported(target.hostId))) {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Agent device access requires enabled device support, agent access, and an available simulator platform on this host.",
        });
      }
      if (!state.hosts.some((host) => host.id === target.hostId && host.kind === "eas"))
        yield* devices.agentTarget({
          threadId: scope.thread.threadId,
          hostId: target.hostId,
          deviceId: target.id,
        });
      const session = yield* devices.open(
        {
          threadId: scope.thread.threadId,
          hostId: target.hostId,
          deviceId: target.id,
          platform: target.platform,
          ...(input.takeOver === undefined ? {} : { takeOver: input.takeOver }),
        },
        { workspaceRoot: yield* threadWorkspaceRoot(scope.thread.threadId), agentRequested: true },
      );
      const after = yield* devices.state;
      // A take-over cannot release another environment's hold, which keeps the device shared.
      const stillInUse = devicesOpenInOtherThreads(
        [...after.sessions, ...(after.externalSessions ?? [])],
        openInOtherThreads.filter((ref) => ref.inUse),
        scope.thread.threadId,
      ).filter(
        (ref) => ref.inUse && ref.hostId === session.hostId && ref.deviceId === session.deviceId,
      );
      const device =
        after.devices.find(
          (candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId,
        ) ?? target;
      // Target the opened device: an EAS device and its agent-device daemon
      // exist only once its session runs, and Android ids change on boot.
      const agent = yield* devices.agentTarget({
        threadId: scope.thread.threadId,
        hostId: device.hostId,
        deviceId: device.id,
      });
      const cloud = after.hosts.some((host) => host.id === device.hostId && host.kind === "eas");
      const targetArgs = [
        ...agentDeviceTargetArgs({ ...device, id: agent.agentDeviceId }),
        ...agent.args,
      ];
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const shimDir = yield* ensureAgentDeviceShim({
        entryPath: yield* devices.agentCli,
        stateDir: config.stateDir,
      }).pipe(
        Effect.mapError(
          (error) =>
            new DeviceToolUnavailableError({
              reason:
                error._tag === "NodeRuntimeUnavailableError"
                  ? nodeRuntimeUnavailableMessage("Device automation")
                  : "Could not prepare the agent-device launcher.",
              cause: error,
            }),
        ),
      );
      const command = path.join(
        shimDir,
        platform === "win32" ? "agent-device.cmd" : "agent-device",
      );
      return {
        device,
        agentDevice: { command, targetArgs },
        quickStart: [
          ...(session.notice ? [session.notice] : []),
          ...(stillInUse.length > 0
            ? [
                `Thread ${stillInUse.map((ref) => ref.threadId).join(", ")} also has this device open, and its agent may be driving it. Coordinate with the user before changing apps or state.`,
              ]
            : []),
          agentDeviceQuickStart(device, targetArgs, command, cloud),
        ].join("\n"),
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_screenshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const sessions = yield* devices.sessionsForThread(scope.thread.threadId);
      const hostId =
        input.deviceId === undefined ? input.hostId : (input.hostId ?? LOCAL_DEVICE_HOST_ID);
      const target = sessions.findLast(
        (session) =>
          (hostId === undefined || session.hostId === hostId) &&
          (input.deviceId === undefined || session.deviceId === input.deviceId),
      );
      if (!target) {
        return yield* new DeviceToolUnavailableError({
          reason:
            input.deviceId === undefined
              ? "No device is open in this thread. Call device_open first."
              : `Device ${input.deviceId} on host ${hostId} is not open in this thread. Call device_open first.`,
        });
      }
      const shot = yield* devices.screenshot(target);
      return {
        device: shot.device,
        screenshot: {
          mimeType: "image/png" as const,
          data: Buffer.from(shot.png).toString("base64"),
          ...pngDimensions(shot.png),
        },
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      yield* devices.close({
        threadId: scope.thread.threadId,
        ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
        ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
        ...(input.shutdown === undefined ? {} : { shutdown: input.shutdown }),
      });
      return {};
    }).pipe(Effect.mapError(toolError)),
  ),
} satisfies McpToolAccess.Handlers<typeof DeviceToolkit.tools>;

export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const isPng =
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a &&
    view.getUint32(12) === 0x49484452;
  return isPng
    ? { width: view.getUint32(16), height: view.getUint32(20) }
    : { width: 0, height: 0 };
}

const { device_screenshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(
  DeviceStandardToolkit,
  McpToolAccess.wrapHandlers(standardHandlers, DeviceFeatureUsage.observeHandlers),
);

export const layerScreenshot = McpToolAccess.toLayer(
  DeviceScreenshotToolkit,
  McpToolAccess.wrapHandlers({ device_screenshot }, (handlers) =>
    Effect.map(DeviceFeatureUsage.snapshotObserver, (observe) => ({
      device_screenshot: (input: Parameters<typeof handlers.device_screenshot>[0]) =>
        observe(handlers.device_screenshot(input)),
    })),
  ),
);
