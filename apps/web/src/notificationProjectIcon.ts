import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

import { projectFaviconCache } from "./assets/projectFaviconCache";
import { projectIconColorClassName } from "./projectIconColors";
import { PROJECT_MONOGRAM_TILE as TILE } from "./projectIdentity";
import {
  createProjectIconCache,
  projectIconSource,
  type ProjectIconSource,
} from "./notificationProjectIcon.logic";

// Sharp at 2x in a macOS thumbnail and at 250% in the 48 px Windows toast logo.
const ICON_SIZE = 128;

/** The colour and font the sidebar tile resolves to in the current appearance. */
function tileStyle(color: Extract<ProjectIconSource, { kind: "monogram" }>["color"]) {
  const probe = document.createElement("span");
  probe.className = `font-mono ${projectIconColorClassName(color)}`;
  probe.hidden = true;
  document.body.append(probe);
  try {
    const style = getComputedStyle(probe);
    return { color: style.color, fontFamily: style.fontFamily };
  } finally {
    probe.remove();
  }
}

async function drawProjectIcon(source: ProjectIconSource): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  const scale = ICON_SIZE / TILE.size;
  if (source.kind === "image") {
    const image = new Image();
    image.src = source.dataUrl;
    await image.decode();
    const fit = Math.min(ICON_SIZE / image.naturalWidth, ICON_SIZE / image.naturalHeight);
    const width = image.naturalWidth * fit;
    const height = image.naturalHeight * fit;
    context.drawImage(image, (ICON_SIZE - width) / 2, (ICON_SIZE - height) / 2, width, height);
  } else if (source.kind === "emoji") {
    context.font = `${ICON_SIZE * 0.8}px sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(source.emoji, ICON_SIZE / 2, ICON_SIZE / 2);
  } else {
    const style = tileStyle(source.color);
    context.fillStyle = style.color;
    context.globalAlpha = TILE.backgroundOpacity;
    context.beginPath();
    context.roundRect(0, 0, ICON_SIZE, ICON_SIZE, TILE.cornerRadius * scale);
    context.fill();
    context.globalAlpha = 1;
    context.font = `${TILE.fontWeight} ${TILE.fontSize * scale}px ${style.fontFamily}`;
    context.textAlign = "center";
    context.textBaseline = "alphabetic";
    const width = context.measureText(source.text).width;
    context.translate(TILE.textX * scale, TILE.textBaseline * scale);
    // Stretched to a fixed width, as the SVG's textLength does.
    if (width > 0) context.scale((TILE.textWidth(source.text) * scale) / width, 1);
    context.fillText(source.text, 0, 0);
  }
  return canvas.toDataURL("image/png");
}

const cache = createProjectIconCache(drawProjectIcon);

function sourceFor(project: EnvironmentProject) {
  const favicon = projectFaviconCache.peek({
    environmentId: project.environmentId,
    cwd: project.workspaceRoot,
    faviconPath: project.faviconPath,
  });
  const dark = document.documentElement.classList.contains("dark");
  return [
    `${project.environmentId}:${project.id}`,
    projectIconSource(project, favicon),
    dark,
  ] as const;
}

/** Draws the project's icon ahead of a notification that may need it. */
export function warmNotificationProjectIcon(project: EnvironmentProject): void {
  try {
    void cache.warm(...sourceFor(project));
  } catch {
    // A notification without an icon is still shown.
  }
}

/** The project's icon as a PNG data URL, or null until it has been drawn. */
export function notificationProjectIcon(project: EnvironmentProject): string | null {
  try {
    return cache.get(...sourceFor(project));
  } catch {
    return null;
  }
}
