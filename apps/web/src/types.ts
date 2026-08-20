import type {
  ChatAttachment as ContractChatAttachment,
  ChatFileAttachment as ContractChatFileAttachment,
  ChatImageAttachment as ContractChatImageAttachment,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointSummary,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationSession,
  ProjectScript as ContractProjectScript,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const DEFAULT_THREAD_TERMINAL_ID = "term-1";
export const MAX_TERMINALS_PER_GROUP = 4;
export type ProjectScript = ContractProjectScript;

export interface ThreadTerminalGroup {
  id: string;
  terminalIds: string[];
  splitDirection?: "horizontal" | "vertical";
}

export interface ChatImageAttachment extends ContractChatImageAttachment {
  readonly previewUrl?: string;
}

export type ChatFileAttachment = ContractChatFileAttachment;

// Unknown future members pass through with the contract shape while known
// files render as file chips and images retain their client preview URL.
export type ChatAttachment =
  | ChatImageAttachment
  | ChatFileAttachment
  | Exclude<
      ContractChatAttachment,
      ContractChatImageAttachment | ContractChatFileAttachment
    >;

// The union has an open member (`type: string`), so a literal comparison does
// not narrow. Use this guard wherever image-only fields are read.
export function isImageAttachment(attachment: ChatAttachment): attachment is ChatImageAttachment {
  return attachment.type === "image";
}

export interface ChatMessage extends Omit<OrchestrationMessage, "attachments"> {
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
}

export type ProposedPlan = OrchestrationProposedPlan;
export type TurnDiffFileChange = OrchestrationCheckpointFile;
export type TurnDiffSummary = OrchestrationCheckpointSummary;

export type Project = EnvironmentProject;
export type Thread = EnvironmentThread;
export type ThreadShell = EnvironmentThreadShell;

export interface ThreadTurnState {
  latestTurn: OrchestrationLatestTurn | null;
}

export type SidebarThreadSummary = EnvironmentThreadShell;
export type ThreadSession = OrchestrationSession;
