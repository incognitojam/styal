import type { T3McpToolDefinition } from "./t3McpToolPresentation.ts";

type ToolLabels = T3McpToolDefinition["labels"];

/**
 * Preview rows show the URL, locator, or key beside the heading, so their
 * wording stays short instead of repeating "in the preview browser". Every
 * published `preview_*` tool needs an entry; the toolkit naming test fails on
 * one upstream adds without it.
 */
export const STYAL_PREVIEW_TOOL_LABELS: Readonly<Record<string, ToolLabels>> = {
  preview_status: ["Check", "Checking", "Checked", "preview status"],
  preview_open: ["Open", "Opening", "Opened", "preview"],
  preview_navigate: ["Navigate", "Navigating", "Navigated", "preview"],
  preview_resize: ["Resize", "Resizing", "Resized", "preview"],
  preview_set_appearance: ["Set", "Setting", "Set", "preview appearance"],
  preview_snapshot: ["Inspect", "Inspecting", "Inspected", "page"],
  preview_click: ["Click", "Clicking", "Clicked", ""],
  preview_type: ["Type", "Typing", "Typed", ""],
  preview_press: ["Press", "Pressing", "Pressed", ""],
  preview_scroll: ["Scroll", "Scrolling", "Scrolled", ""],
  preview_hover: ["Hover", "Hovering", "Hovered", ""],
  preview_select: ["Choose", "Choosing", "Chose", "option"],
  preview_drag: ["Drag", "Dragging", "Dragged", ""],
  preview_upload: ["Upload", "Uploading", "Uploaded", "files"],
  preview_dialog: ["Respond", "Responding", "Responded", "to dialog"],
  preview_evaluate: ["Run", "Running", "Ran", "JS in preview"],
  preview_wait_for: ["Wait", "Waiting", "Waited", "for condition"],
  preview_recording_start: ["Start", "Starting", "Started", "recording preview"],
  preview_recording_stop: ["Stop", "Stopping", "Stopped", "recording preview"],
};

/** Upstream's labels name the product ("a T3 thread"); styal's threads are just threads. */
function withoutProductName(labels: ToolLabels): ToolLabels {
  const strip = (label: string) => label.replace(/\bT3 /gu, "");
  return [strip(labels[0]), strip(labels[1]), strip(labels[2]), strip(labels[3])];
}

/**
 * styal's wording for a tool in upstream's shared table. Applied where the
 * table is read, so upstream's entries merge without conflicts and tools it
 * adds arrive worded.
 */
export function styalToolDefinition(
  name: string,
  definition: T3McpToolDefinition,
): T3McpToolDefinition {
  const labels = withoutProductName(STYAL_PREVIEW_TOOL_LABELS[name] ?? definition.labels);
  return {
    ...definition,
    labels,
    displayName: Object.hasOwn(STYAL_PREVIEW_TOOL_LABELS, name)
      ? [labels[0], labels[3]].filter((part) => part.length > 0).join(" ")
      : definition.displayName.replace(/\bT3 /gu, ""),
  };
}

/**
 * Lifecycle wording shared by timeline rows, mobile, and group previews.
 */
export function styalToolHeading(
  definition: T3McpToolDefinition,
  status: string | undefined,
  target = definition.labels[3],
): string {
  const [action, running, completed] = definition.labels;
  const verb =
    status === "failed"
      ? `Failed to ${action.toLowerCase()}`
      : status === "declined"
        ? `Declined to ${action.toLowerCase()}`
        : status === "stopped"
          ? `Stopped ${running.toLowerCase()}`
          : status === "completed"
            ? completed
            : running;
  return target.length > 0 ? `${verb} ${target}` : verb;
}
