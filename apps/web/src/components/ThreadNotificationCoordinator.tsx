import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import type { AnyRouter } from "@tanstack/react-router";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  buildProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
  threadDisplayName,
} from "@t3tools/contracts";
import { monitorHoldsWakeCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { getDocumentActivity } from "../lib/documentActivity";
import { isWindowsPlatform } from "../lib/utils";
import { environmentSummaries } from "../state/presentation";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentProjects } from "../state/projects";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { notificationProjectIcon, warmNotificationProjectIcon } from "../notificationProjectIcon";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  prepareNotificationAudio,
  notificationSoundForEvent,
  setNotificationBadge,
  threadNotificationTag,
  unlockNotificationAudio,
} from "../threadNotifications";
import { type SystemNotificationHandle, showSystemNotification } from "../systemNotifications";
import { resolveBackgroundThreadRequest } from "./backgroundThreadAnnouncement";
import {
  resolveThreadListStatus,
  type ThreadListStatus,
} from "@t3tools/client-runtime/state/thread-list-status";
import {
  isProjectPageJob,
  projectChatTakesReports,
  staysOnProjectPage,
} from "./project/projectPage.logic";
import { environmentServerConfigsAtom, projectJobThreadIdsAtom } from "../state/server";
import {
  createThreadNotificationGate,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";
import { toastManager } from "./ui/toast";

const NO_KEYS: ReadonlySet<string> = new Set();

// A workflow run's deployment review outlives the agent run that was latest when it
// appeared, so keying it by run would alert again on every message sent while it waits.
function attentionSubject(thread: OrchestrationV2ThreadShell): string | null {
  if (thread.pendingRuntimeRequest) return thread.pendingRuntimeRequest.id;
  const reviews = (thread.workflowRuns ?? []).filter((run) => run.review !== undefined);
  if (reviews.length === 0) return null;
  return reviews.map((run) => `${run.host}/${run.repository}#${run.runId}`).join(",");
}

interface NotificationState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: ThreadListStatus;
}

type ToastId = ReturnType<typeof toastManager.add>;

interface WatchedEnvironment {
  unsubscribe: () => void;
  previous: Map<ThreadId, NotificationState>;
  reconnecting: boolean;
  readonly gate: ReturnType<typeof createThreadNotificationGate<ThreadId>>;
}

/**
 * Turns thread status transitions in every connected environment into sounds, in-app toasts,
 * and desktop notifications, and keeps the dock badge in step with the unread ones.
 */
export function startThreadNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const pending = new Map<
    string,
    { environmentId: EnvironmentId; threadId: ThreadId; notification: SystemNotificationHandle }
  >();
  const watched = new Map<EnvironmentId, WatchedEnvironment>();

  const trackNotification = (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tag: string,
    notification: SystemNotificationHandle,
  ) => {
    pending.get(tag)?.notification.close();
    pending.set(tag, { environmentId, threadId, notification });
    setNotificationBadge(pending.size);
  };
  // Toast ids by thread key, so hiding or opening a thread can close its open toasts.
  const openToasts = new Map<string, Array<ToastId>>();
  const forgetToast = (key: string, toastId: ToastId) => {
    const remaining = (openToasts.get(key) ?? []).filter((id) => id !== toastId);
    if (remaining.length === 0) openToasts.delete(key);
    else openToasts.set(key, remaining);
  };
  const closeToasts = (shouldClose: (key: string) => boolean) => {
    for (const [key, toastIds] of openToasts) {
      if (!shouldClose(key)) continue;
      for (const toastId of toastIds) toastManager.close(toastId);
      openToasts.delete(key);
    }
  };
  const activeThread = () =>
    (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: EnvironmentId;
      threadId?: ThreadId;
    };
  const closeOpenedThreadToasts = () => {
    const { environmentId, threadId } = activeThread();
    if (environmentId === undefined || threadId === undefined) return;
    const opened = threadKey({ environmentId, threadId });
    closeToasts((key) => key === opened);
  };
  // A notification shown before the tag filter turned on must not stay on screen. While hiding,
  // one whose thread left the live list (archived) cannot be judged, so it closes too.
  const closeHiddenPending = () => {
    const hidden = registry.get(environmentThreadShells.hiddenThreadKeysAtom);
    const live = registry.get(environmentThreadShells.anyEnvironmentHidingAtom)
      ? new Set(registry.get(environmentThreadShells.threadRefsAtom).map(threadKey))
      : null;
    const shouldClose = (key: string) => hidden.has(key) || (live !== null && !live.has(key));
    closeToasts(shouldClose);
    const count = pending.size;
    for (const [tag, entry] of pending) {
      if (!shouldClose(threadKey(entry))) continue;
      entry.notification.close();
      pending.delete(tag);
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
  };
  const clearPending = () => {
    for (const { notification } of pending.values()) notification.close();
    pending.clear();
    setNotificationBadge(0);
  };

  // The project's sidebar group: its label names the project chat, its representative's icon is
  // the one the sidebar shows.
  const projectGroup = (environmentId: EnvironmentId, projectId: ProjectId) =>
    buildProjectGroups({
      projects: registry.get(environmentProjects.projectsAtom),
      settings: selectProjectGroupingSettings(getClientSettings()),
      preferredEnvironmentId: registry.get(primaryEnvironmentIdAtom),
    }).find((group) =>
      group.memberProjectRefs.some(
        (ref) => ref.environmentId === environmentId && ref.projectId === projectId,
      ),
    );
  const iconProject = (environmentId: EnvironmentId, projectId: ProjectId) =>
    projectGroup(environmentId, projectId)?.representative ??
    registry.get(environmentProjects.projectAtom(scopeProjectRef(environmentId, projectId)));

  const present = (
    environmentId: EnvironmentId,
    state: NotificationState,
    kind: ThreadNotificationKind,
  ) => {
    const { thread, status } = state;
    if (
      registry
        .get(environmentThreadShells.hiddenThreadKeysAtom)
        .has(threadKey({ environmentId, threadId: thread.id }))
    )
      return;
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const active = activeThread();
    const isViewed = () => {
      const activity = getDocumentActivity();
      const params = router.state.matches.at(-1)?.params as typeof active;
      return (
        activity.visible &&
        activity.focused &&
        params?.environmentId === environmentId &&
        params?.threadId === thread.id
      );
    };
    const shouldSound = () => kind !== "completion" || !isViewed();
    const name = threadDisplayName(
      registry.get(environmentServerConfigsAtom).get(environmentId)?.settings,
      thread,
      () => projectGroup(environmentId, thread.projectId)?.label ?? null,
    );
    const title =
      kind === "completion"
        ? "Thread completed"
        : status === "approval"
          ? "Approval needed"
          : status === "limited"
            ? "Usage limit reached"
            : status === "failed"
              ? "Thread failed"
              : status === "request"
                ? "Guest request"
                : "Input needed";
    const allowSound = shouldSound;
    if (hasNotificationSound(mode) && allowSound()) {
      const event = status === "approval" ? "approval" : kind;
      const sound = notificationSoundForEvent(getClientSettings(), event);
      void playNotificationSound(
        kind,
        () =>
          hasNotificationSound(getClientSettings().notificationMode) &&
          allowSound() &&
          notificationSoundForEvent(getClientSettings(), event) === sound,
        sound,
      );
    }
    if (
      inAppNotificationsEnabled &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      (active.environmentId !== environmentId || active.threadId !== thread.id)
    ) {
      const toastKey = threadKey({ environmentId, threadId: thread.id });
      const toastId: ToastId = toastManager.add({
        onRemove: (): void => forgetToast(toastKey, toastId),
        type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
        title,
        description: name,
        data: {
          hideCopyButton: true,
          leadingIcon:
            kind === "completion" ? (
              <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
            ) : status === "approval" ? (
              <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
            ) : status === "limited" ? (
              <CircleAlertIcon aria-hidden className="size-4 text-warning-foreground" />
            ) : status === "failed" ? (
              <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
            ) : (
              <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
            ),
        },
        actionProps: {
          children: "Open thread",
          onClick: () => {
            toastManager.close(toastId);
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: thread.id },
            });
          },
        },
      });
      openToasts.set(toastKey, [...(openToasts.get(toastKey) ?? []), toastId]);
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      (document.visibilityState === "visible" && document.hasFocus())
    )
      return;
    const tag = threadNotificationTag(environmentId, thread.id);
    const project = iconProject(environmentId, thread.projectId);
    const icon = project === null ? null : notificationProjectIcon(project);
    const notification = showSystemNotification({
      title,
      body: name,
      tag,
      ...(icon === null ? {} : { icon }),
      requireInteraction: kind === "completion" && isWindowsPlatform(navigator.platform),
      onClick: () =>
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: thread.id },
        }),
    });
    if (notification) trackNotification(environmentId, thread.id, tag, notification);
  };

  const observeThreads = (
    environmentId: EnvironmentId,
    entry: WatchedEnvironment,
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) => {
    const previous = entry.previous;
    const next = new Map<ThreadId, NotificationState>();
    // A parent here also hears of what its tasks on linked environments ask.
    const subagentRequests = registry.get(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
    );
    const delegatedUnderParent = registry.get(environmentThreadShells.delegatedUnderParentAtom);
    // A thread the project chat launched, or a scheduled task's thread its project page keeps,
    // finishes quietly while it stays off the sidebar.
    const settings = registry.get(environmentServerConfigsAtom).get(environmentId)?.settings;
    const jobThreadIds = new Set(registry.get(projectJobThreadIdsAtom(environmentId)).split("\n"));
    const jobThreadKeys = (thread: EnvironmentThreadShell): ReadonlySet<string> => {
      const group = projectGroup(environmentId, thread.projectId);
      return isProjectPageJob(
        thread,
        jobThreadIds,
        settings,
        group && { isScratch: group.representative.isScratch, archived: group.archived },
      )
        ? new Set([`${environmentId}:${thread.id}`])
        : NO_KEYS;
    };
    let projectChatKeys: ReadonlySet<string> | null = null;
    const reportingChatKeys = () => {
      if (projectChatKeys !== null) return projectChatKeys;
      const chatIds = new Set(
        settings?.projectCoordinatorsEnabled
          ? Object.values(settings.projectCoordinators ?? {}).map((chat) => chat.threadId)
          : [],
      );
      projectChatKeys = new Set(
        threads.flatMap((thread) =>
          chatIds.has(thread.id) && projectChatTakesReports(thread)
            ? [`${environmentId}:${thread.id}`]
            : [],
        ),
      );
      return projectChatKeys;
    };
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    for (const rawThread of threads) {
      if (
        isShownUnderParent(
          { environmentId, threadId: rawThread.id },
          rawThread.lineage,
          delegatedUnderParent,
        )
      ) {
        continue;
      }
      const prior = previous.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (
        !entry.reconnecting &&
        prior?.raw === rawThread &&
        prior.subagentRequest === subagentRequest
      ) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveThreadListStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const needsAttention =
        status === "input" ||
        status === "request" ||
        status === "approval" ||
        status === "failed" ||
        status === "limited";
      const requestId = needsAttention ? resolveBackgroundThreadRequest(thread).requestId : null;
      // Queued messages become the latest run while a request stays pending, so a request
      // with an id is keyed by that id alone and announces once.
      const subject =
        status === "approval" || status === "input" ? attentionSubject(rawThread) : null;
      const attention = !needsAttention
        ? null
        : requestId !== null
          ? `${status}:${requestId}`
          : subject !== null
            ? `${status}:${subject}`
            : `${thread.latestRun?.runId ?? ""}:${status}`;
      const completed = status === "ready" && thread.latestRun?.status === "completed";
      const settled =
        completed &&
        !monitorHoldsWakeCompletion(rawThread) &&
        !(
          ((rawThread.reportTo != null && rawThread.reportTo.source === undefined) ||
            jobThreadIds.has(rawThread.id)) &&
          staysOnProjectPage(thread, reportingChatKeys(), jobThreadKeys(thread))
        );
      const parsedCompletedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const completedAt = Number.isFinite(parsedCompletedAt) ? parsedCompletedAt : null;
      // Draw the project's icon when work starts, so it is ready when the thread notifies.
      if (
        (status === "preparing" || status === "working") &&
        prior?.status !== "preparing" &&
        prior?.status !== "working"
      ) {
        const project = iconProject(environmentId, rawThread.projectId);
        if (project !== null) warmNotificationProjectIcon(project);
      }
      const state = {
        raw: rawThread,
        subagentRequest,
        thread,
        status,
        attention,
        requestId,
        settled,
        completedAt: settled ? completedAt : null,
        backgroundWake: rawThread.latestRunBackgroundWake === true,
      };
      next.set(thread.id, state);
      changed.push([prior, state]);
    }
    entry.reconnecting = false;
    entry.previous = next;
    entry.gate.retain(new Set(next.keys()));
    for (const [prior, state] of changed) {
      entry.gate.observe(state.thread.id, prior, state, {
        archived: state.thread.archivedAt !== null,
        quiet: state.raw.latestRunStopRequested === true,
      });
    }
  };

  const watchEnvironment = (environmentId: EnvironmentId): WatchedEnvironment => {
    const entry: WatchedEnvironment = {
      previous: new Map(),
      reconnecting: false,
      unsubscribe: () => {},
      gate: createThreadNotificationGate<ThreadId>((threadId, kind) => {
        const state = entry.previous.get(threadId);
        if (state) present(environmentId, state, kind);
      }),
    };
    let threads: ReadonlyArray<OrchestrationV2ThreadShell> | null = null;
    const unsubscribeShell = registry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (shell) => {
        threads =
          shell.status === "live" && Option.isSome(shell.snapshot)
            ? shell.snapshot.value.threads
            : null;
        if (threads !== null) {
          observeThreads(environmentId, entry, threads);
          return;
        }
        entry.reconnecting = true;
        entry.gate.pause();
      },
      { immediate: true },
    );
    const reobserve = () => {
      if (threads !== null) observeThreads(environmentId, entry, threads);
    };
    const unsubscribeRequests = registry.subscribe(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
      reobserve,
    );
    const unsubscribeDelegated = registry.subscribe(
      environmentThreadShells.delegatedUnderParentAtom,
      reobserve,
    );
    const unmountJobThreadIds = registry.mount(projectJobThreadIdsAtom(environmentId));
    entry.unsubscribe = () => {
      unsubscribeShell();
      unsubscribeRequests();
      unsubscribeDelegated();
      unmountJobThreadIds();
      entry.gate.clear();
    };
    return entry;
  };

  const syncEnvironments = () => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const enabled = notificationMode !== "off" || inAppNotificationsEnabled;
    if (!enabled) closeToasts(() => true);
    const environmentIds = enabled ? registry.get(environmentSummaries.environmentIdsAtom) : [];
    const activeIds = new Set(environmentIds);
    for (const [environmentId, entry] of watched) {
      if (activeIds.has(environmentId)) continue;
      entry.unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watchEnvironment(environmentId));
    }
  };

  const pruneRemovedEnvironments = () => {
    const activeIds = new Set(registry.get(environmentSummaries.environmentIdsAtom));
    const count = pending.size;
    for (const [tag, entry] of pending) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.delete(tag);
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
  };

  // Listeners that only exist for some notification modes, rebuilt when the mode changes.
  let appliedMode: ClientSettings["notificationMode"] | null = null;
  let stopModeListeners = () => {};
  const applyMode = () => {
    const nextMode = getClientSettings().notificationMode;
    if (nextMode === appliedMode) return;
    appliedMode = nextMode;
    stopModeListeners();
    clearPending();
    const stops: Array<() => void> = [];
    if (hasDesktopNotifications(nextMode)) {
      const unsubscribeBadgeClear = window.desktopBridge?.onNotificationBadgeClear(clearPending);
      window.addEventListener("focus", clearPending);
      stops.push(() => {
        unsubscribeBadgeClear?.();
        window.removeEventListener("focus", clearPending);
        clearPending();
      });
    }
    if (hasNotificationSound(nextMode)) {
      // Safari has no requestIdleCallback.
      if ("requestIdleCallback" in window) window.requestIdleCallback(prepareNotificationAudio);
      else setTimeout(prepareNotificationAudio);
      const unlockAudio = () => {
        const settings = getClientSettings();
        void unlockNotificationAudio([
          notificationSoundForEvent(settings, "completion"),
          notificationSoundForEvent(settings, "input"),
          notificationSoundForEvent(settings, "approval"),
        ]);
      };
      document.addEventListener("pointerdown", unlockAudio);
      document.addEventListener("keydown", unlockAudio);
      stops.push(() => {
        document.removeEventListener("pointerdown", unlockAudio);
        document.removeEventListener("keydown", unlockAudio);
      });
    }
    stopModeListeners = () => {
      for (const stop of stops) stop();
    };
  };

  const onSettings = () => {
    applyMode();
    syncEnvironments();
  };
  const unsubscribeSettings = subscribeClientSettings(onSettings);
  const unsubscribeEnvironmentIds = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    () => {
      pruneRemovedEnvironments();
      syncEnvironments();
    },
  );
  const unsubscribeHidden = [
    registry.subscribe(environmentThreadShells.hiddenThreadKeysAtom, closeHiddenPending),
    registry.subscribe(environmentThreadShells.anyEnvironmentHidingAtom, closeHiddenPending),
    registry.subscribe(environmentThreadShells.threadRefsAtom, closeHiddenPending),
  ];
  const unsubscribeRoute = router.subscribe("onResolved", closeOpenedThreadToasts);
  onSettings();

  return () => {
    unsubscribeSettings();
    unsubscribeEnvironmentIds();
    for (const unsubscribe of unsubscribeHidden) unsubscribe();
    unsubscribeRoute();
    for (const entry of watched.values()) entry.unsubscribe();
    watched.clear();
    stopModeListeners();
    closeToasts(() => true);
  };
}
