import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import type { SidebarThreadAttention } from "../Sidebar.logic";

/** How a thread row's status slot labels and colours what the thread needs. */
export const SIDEBAR_ATTENTION_STATUS = {
  approval: { label: "Approval", icon: "approval", className: "text-warning-foreground" },
  input: { label: "Input", icon: "input", className: "text-indigo-600 dark:text-indigo-300" },
  request: { label: "Request", icon: "request", className: "text-guest-foreground" },
  limited: { label: "Limited", icon: "failed", className: "text-warning" },
  failed: { label: "Failed", icon: "failed", className: "text-error" },
  woke: { label: "Woke", icon: "woke", className: "text-warning" },
  done: { label: "Done", icon: "done", className: "text-success" },
} as const satisfies Record<
  SidebarThreadAttention,
  { label: string; icon: string; className: string }
>;

/** The status icon in its status colour. */
export function SidebarAttentionIcon(props: { attention: SidebarThreadAttention }) {
  const className = cn("size-4 shrink-0", SIDEBAR_ATTENTION_STATUS[props.attention].className);
  switch (SIDEBAR_ATTENTION_STATUS[props.attention].icon) {
    case "approval":
      return <ShieldQuestionIcon aria-hidden className={className} />;
    case "input":
      return <MessageCircleQuestionIcon aria-hidden className={className} />;
    case "request":
      return <UserRoundIcon aria-hidden className={className} />;
    case "failed":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "woke":
      return <AlarmClockIcon aria-hidden className={className} />;
    case "done":
      return <CircleCheckIcon aria-hidden className={className} />;
  }
}
