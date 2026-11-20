import { AppBar } from "../../components/ui/AppBar";
import { SourceCheckoutNotice } from "../../components/SourceCheckoutNotice";
import { EnvironmentId } from "@t3tools/contracts";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly cwd: string | null;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  /** Set when this thread is its project's chat: the header then belongs to the project. */
  readonly project?: {
    readonly onNewThread: () => void;
    readonly onOpenSettings: () => void;
  };
}) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? "Close files" : "Open files",
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  const menus = props.project
    ? [projectMenu(props.project.onOpenSettings, actions[0], terminalMenu)]
    : [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);

  return (
    <>
      <AppBar
        title={props.title}
        subtitle={props.subtitle}
        onBackToList={goBack}
        // The project's own New thread action replaces split view's generic one.
        onCompose={props.draft || props.project ? undefined : startNewTask}
        backInSplitView={
          props.onReturnToThread
            ? {
                accessibilityLabel: "Return to chat",
                icon: "chevron.left",
                onPress: props.onReturnToThread,
              }
            : undefined
        }
        actions={
          props.project
            ? [
                {
                  accessibilityLabel: "New thread",
                  icon: "square.and.pencil",
                  onPress: props.project.onNewThread,
                },
              ]
            : actions
        }
        menus={menus}
        hideBottomBorder
      />
      {props.cwd ? (
        <SourceCheckoutNotice
          environmentId={EnvironmentId.make(props.gitControls.environmentId)}
          cwd={props.cwd}
        />
      ) : null}
    </>
  );
}

/** The project chat's one menu: settings, then the thread's own files and terminals. */
function projectMenu(
  onOpenSettings: () => void,
  files: AppBarAction | undefined,
  terminal: AppBarMenu | null,
): AppBarMenu {
  return {
    title: "Project",
    icon: "ellipsis",
    items: [
      {
        id: "project-settings",
        title: "Project settings",
        icon: "gearshape",
        onPress: onOpenSettings,
      },
      ...(files
        ? [
            {
              id: "project-files",
              title: files.accessibilityLabel,
              icon: "folder",
              disabled: files.disabled,
              onPress: files.onPress,
            },
          ]
        : []),
      ...(terminal
        ? [{ id: "project-terminal", title: "Terminal", icon: "terminal", items: terminal.items }]
        : []),
    ],
  };
}
