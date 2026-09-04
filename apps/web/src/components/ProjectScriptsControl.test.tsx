import type { ProjectScript, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import ProjectScriptsControl, { openAddProjectScriptEditor } from "./ProjectScriptsControl";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const PRIMARY_SCRIPT: ProjectScript = {
  id: "dev",
  name: "Dev",
  command: "vp dev",
  icon: "play",
  runOnWorktreeCreate: false,
};

function renderControl(
  scripts: ReadonlyArray<ProjectScript>,
  legacyScripts: ReadonlyArray<ProjectScript> = [],
  hasLegacyConfig = legacyScripts.length > 0,
  canEdit = true,
) {
  return renderToStaticMarkup(
    <ProjectScriptsControl
      scripts={scripts}
      legacyScripts={legacyScripts}
      hasLegacyConfig={hasLegacyConfig}
      canEdit={canEdit}
      keybindings={EMPTY_KEYBINDINGS}
      onRunScript={() => {}}
      onMigrateLegacyScripts={async () => undefined as never}
      onAddScript={async () => undefined as never}
      onUpdateScript={async () => undefined as never}
      onDeleteScript={async () => undefined as never}
    />,
  );
}

function buttonTag(html: string, ariaLabel: string) {
  return html.match(new RegExp(`<button[^>]*aria-label="${ariaLabel}"[^>]*>`))?.[0];
}

function expectResponsiveXsControl(markup: string | undefined) {
  expect(markup).toBeDefined();
  expect(markup).toContain("h-7");
  expect(markup).toContain("gap-1");
  expect(markup).toContain("text-sm");
  expect(markup).toContain("sm:h-6");
  expect(markup).toContain("sm:text-xs");
  expect(markup).toContain("w-7");
  expect(markup).toContain("px-0");
  expect(markup).toContain("sm:w-6");
  expect(markup).toContain("@3xl/header-actions:w-auto!");
  expect(markup).toContain("@3xl/header-actions:px-[calc(--spacing(2)-1px)]");
}

describe("ProjectScriptsControl compact controls", () => {
  it("refreshes file actions before opening the Add action editor", () => {
    const calls: string[] = [];

    openAddProjectScriptEditor({
      refreshFileScripts: () => calls.push("refresh"),
      openEditor: () => calls.push("open"),
    });

    expect(calls).toEqual(["refresh", "open"]);
  });

  it("keeps the primary Run control compact and expands it with its label", () => {
    const html = renderControl([PRIMARY_SCRIPT]);

    expectResponsiveXsControl(buttonTag(html, "Run Dev"));
    expect(html).toContain(
      'class="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5"',
    );
  });

  it("keeps the standalone Add control compact and expands it with its label", () => {
    const html = renderControl([]);

    expectResponsiveXsControl(buttonTag(html, "Add action"));
    expect(html).toContain(
      'class="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5"',
    );
  });

  it("runs a styal.json action directly without importing it", () => {
    const html = renderControl([PRIMARY_SCRIPT]);

    expectResponsiveXsControl(buttonTag(html, "Run Dev"));
    expect(html).not.toContain('aria-label="Add action"');
    expect(html).not.toContain("styal.json");
  });

  it("keeps a legacy action behind migration", () => {
    const html = renderControl([], [PRIMARY_SCRIPT]);

    expect(buttonTag(html, "Run Dev")).toBeUndefined();
    expect(buttonTag(html, "Project actions")).toBeDefined();
  });

  it("offers migration for a legacy config without actions", () => {
    const html = renderControl([], [], true);

    expect(buttonTag(html, "Project actions")).toBeDefined();
  });

  it("disables Add action while the project file is unavailable", () => {
    expect(buttonTag(renderControl([], [], false, false), "Add action")).toContain("disabled");
  });
});
