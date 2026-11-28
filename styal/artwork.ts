import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Install pre-exported artwork; no Apple-only icon exporter is needed during a move.
export function installArtwork() {
  NodeFS.copyFileSync("styal/branding/artwork.css", "apps/web/src/styal-artwork.css");
  const styles = "apps/web/src/index.css";
  NodeFS.writeFileSync(
    styles,
    NodeFS.readFileSync(styles, "utf8")
      .replace('@import "tailwindcss";', '@import "tailwindcss";\n@import "./styal-artwork.css";')
      .replace(
        /Keep the original T3 Code artwork palettes as the defaults\. Built-in\s+themes override them with their own pigments in the components layer\./,
        "Named themes override these pigments; styal supplies the default artwork colorway.",
      ),
  );
  for (const entry of NodeFS.readdirSync("styal/assets", {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const source = NodePath.join(entry.parentPath, entry.name);
    const target = source.slice("styal/".length);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.copyFileSync(source, target);
    const upstreamTarget = target.replace(/\/(black|blueprint|nightly)-(web|windows)/, "/t3-$1-$2");
    if (NodeFS.existsSync(upstreamTarget)) NodeFS.copyFileSync(source, upstreamTarget);
  }
  for (const name of NodeFS.readdirSync("styal/apps/mobile/assets")) {
    NodeFS.copyFileSync(`styal/apps/mobile/assets/${name}`, `apps/mobile/assets/${name}`);
  }
  for (const name of NodeFS.readdirSync("apps/web/public")) {
    const source = `styal/assets/prod/black-web-${name.replace("apple-touch-icon.png", "apple-touch-180.png").replace("icon-", "icon-")}`;
    if (NodeFS.existsSync(source)) NodeFS.copyFileSync(source, `apps/web/public/${name}`);
  }
  NodeFS.copyFileSync("styal/assets/prod/black-web-favicon.svg", "apps/web/public/favicon.svg");

  NodeFS.writeFileSync(
    "apps/web/src/components/SidebarStageBackdrop.tsx",
    NodeFS.readFileSync("styal/branding/SidebarStageBackdrop.tsx", "utf8").replace(
      /^(  if \(normalized === "(?:dev|nightly)"\) return "(?:Dev|Nightly)";)$/gm,
      "  // oxlint-disable-next-line t3code/no-untranslated-copy -- release channel names\n$1",
    ),
  );
  for (const variant of ["latest", "nightly"])
    NodeFS.copyFileSync(
      `styal/branding/dmg-background-${variant}.svg`,
      `apps/desktop/resources/dmg/dmg-background-${variant}.svg`,
    );
  for (const variant of ["dev", "nightly", "prod"]) {
    const icon =
      variant === "dev"
        ? "dev/blueprint"
        : variant === "nightly"
          ? "nightly/nightly"
          : "prod/black";
    NodeFS.copyFileSync(
      `styal/assets/${icon}-ios-1024.png`,
      `apps/mobile/assets/android-splash-icon-${variant}.png`,
    );
  }
  const wordmark = NodeFS.readFileSync("styal/branding/StyalWordmark.tsx", "utf8");
  NodeFS.writeFileSync(
    "apps/web/src/components/T3Wordmark.tsx",
    wordmark
      .replace('import { cn } from "../lib/utils";', 'import type { SVGProps } from "react";')
      .replace(
        "export function StyalWordmark({ className }: { className?: string })",
        "export function T3Wordmark(props: SVGProps<SVGSVGElement>)",
      )
      .replace('className={cn("h-4 w-auto shrink-0", className)}', "{...props}"),
  );
  const replace = (file: string, from: string | RegExp, to: string) => {
    const before = NodeFS.readFileSync(file, "utf8");
    const after = before.replace(from, to);
    if (before === after) throw new Error(`Artwork anchor missing: ${file}`);
    NodeFS.writeFileSync(file, after);
  };
  replace(
    "apps/web/src/components/sidebar/SidebarChrome.tsx",
    /function SidebarBrandMark\([\s\S]*?\n}\n/,
    'function SidebarBrandMark({ onBackdrop }: { onBackdrop: boolean }) {\n return <T3Wordmark aria-label="styal" className={cn("h-4 w-auto shrink-0", onBackdrop ? "text-white" : "text-foreground")} />;\n}\n',
  );
  replace(
    "apps/web/src/components/ui/standalone-page.tsx",
    /\s*\{\/\* oxlint-disable-next-line t3code\/no-untranslated-copy -- product wordmark \*\/}\s*<span className="text-lg font-medium tracking-tight">Code<\/span>/,
    "",
  );
  const mobile = "apps/mobile/src/components/T3Wordmark.tsx";
  const svg = NodeFS.readFileSync("styal/assets/brand/wordmark.svg", "utf8");
  const d = svg.match(/d="([^"]+)"/)![1];
  const viewBox = svg.match(/viewBox="([^"]+)"/)![1];
  replace(mobile, /const aspectRatio = [^;]+;/, "const aspectRatio = 2052.5 / 901;");
  replace(mobile, /accessibilityLabel="T3"/, 'accessibilityLabel="styal"');
  replace(mobile, /viewBox="[^"]+"/, `viewBox="${viewBox}"`);
  replace(mobile, /d="[^"]+"/, `d="${d}" transform="translate(0 475) scale(1 -1)"`);
  const title = "apps/mobile/src/components/CompactBrandTitle.tsx";
  replace(title, 'const WORDMARK_SUFFIX = "Code";\n', "");
  replace(
    title,
    /\s*\{\/\* A logo beside a fixed-size wordmark:[\s\S]*?\{WORDMARK_SUFFIX\}\s*<\/Text>/,
    "",
  );
}
