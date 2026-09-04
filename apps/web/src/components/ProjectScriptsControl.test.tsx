import type {
  ProjectScript,
  ResolvedKeybindingsConfig,
  T3ProjectFileScript,
} from "@t3tools/contracts";
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
  fileScripts: ReadonlyArray<ProjectScript> = [],
  legacyFileScripts: ReadonlyArray<T3ProjectFileScript> = [],
) {
  return renderToStaticMarkup(
    <ProjectScriptsControl
      scripts={scripts}
      fileScripts={fileScripts}
      legacyFileScripts={legacyFileScripts}
      keybindings={EMPTY_KEYBINDINGS}
      onRunScript={() => {}}
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
    const html = renderControl([], [PRIMARY_SCRIPT]);

    expectResponsiveXsControl(buttonTag(html, "Run Dev"));
    expect(html).not.toContain('aria-label="Add action"');
  });

  it("keeps a legacy t3.json action behind the import menu", () => {
    const html = renderControl([], [], [{ name: "Dev", command: "vp dev" }]);

    expect(buttonTag(html, "Run Dev")).toBeUndefined();
    expect(buttonTag(html, "Project actions")).toBeDefined();
  });
});
