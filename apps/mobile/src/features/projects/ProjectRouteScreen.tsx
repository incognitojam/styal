import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect } from "react";

import { LoadingScreen } from "../../components/LoadingScreen";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { savedConnectionsByIdAtom } from "../../state/use-remote-environment-registry";
import { useProjectChats } from "./projectChats";
import { resolveProjectLink } from "./projectChats.logic";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** `projects/<environmentId>/<projectId>`: opens the project's chat, which is its screen. */
export function ProjectRouteScreen(
  props: StaticScreenProps<{
    readonly environmentId?: string | string[];
    readonly projectId?: string | string[];
  }>,
) {
  const navigation = useNavigation();
  const environmentIdRaw = first(props.route.params?.environmentId);
  const projectIdRaw = first(props.route.params?.projectId) ?? "";
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const chats = useProjectChats();
  const saved = useAtomValue(savedConnectionsByIdAtom);
  const connected = useAtomValue(connectedEnvironmentIdsAtom);
  const shell = useEnvironmentShellReadiness(environmentId);
  const chat =
    environmentId === null
      ? undefined
      : chats.byCheckoutKey.get(scopedProjectKey(environmentId, ProjectId.make(projectIdRaw)));
  const target = resolveProjectLink({
    chat,
    environmentSaved: environmentId !== null && saved[environmentId] !== undefined,
    connected: environmentId !== null && connected.includes(environmentId),
    shellLive: shell.status === "live" || shell.hasError,
    shellCacheRead: shell.cacheRead,
  });
  const chatEnvironmentId = chat?.chat.environmentId;
  const chatThreadId = chat?.chat.id;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replaces this link route with the screen it resolves to once the project's machine has loaded
  useEffect(() => {
    if (target === "wait") return;
    navigation.dispatch(
      target === "chat" && chatEnvironmentId !== undefined && chatThreadId !== undefined
        ? StackActions.replace("Thread", {
            environmentId: String(chatEnvironmentId),
            threadId: String(chatThreadId),
          })
        : StackActions.replace("Home"),
    );
  }, [navigation, target, chatEnvironmentId, chatThreadId]);
  return <LoadingScreen message="Opening project…" messagePlacement="above-spinner" />;
}
