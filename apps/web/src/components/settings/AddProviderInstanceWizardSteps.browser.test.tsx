import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ADD_PROVIDER_WIZARD_STEPS } from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";

let root: Root | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function renderStepButtons(
  currentStep: number,
  instanceIdError: string | null,
  onNavigation: Parameters<typeof AddProviderInstanceWizardSteps>[0]["onNavigation"],
) {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <AddProviderInstanceWizardSteps
        currentStep={currentStep}
        summaries={["Codex", "Codex Workspace", null]}
        instanceIdError={instanceIdError}
        onNavigation={onNavigation}
      />,
    );
  });
  return [...container.querySelectorAll("button")];
}

describe("AddProviderInstanceWizardSteps", () => {
  it("gates the actual Config header click through Identity validation", async () => {
    const onNavigation = vi.fn();
    const buttons = await renderStepButtons(0, "Instance ID is required.", onNavigation);

    expect(buttons).toHaveLength(ADD_PROVIDER_WIZARD_STEPS.length);
    await act(async () => buttons[2]!.click());

    expect(onNavigation).toHaveBeenCalledOnce();
    expect(onNavigation).toHaveBeenCalledWith({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("marks the wizard step separately from the clicked button focus", async () => {
    const buttons = await renderStepButtons(1, "Instance ID is required.", vi.fn());

    expect(buttons[0]!.getAttribute("aria-current")).toBeNull();
    expect(buttons[1]!.getAttribute("aria-current")).toBe("step");
    expect(buttons[2]!.getAttribute("aria-current")).toBeNull();
  });

  it("preserves the actual backward header click", async () => {
    const onNavigation = vi.fn();
    const buttons = await renderStepButtons(2, "Instance ID is required.", onNavigation);

    await act(async () => buttons[0]!.click());

    expect(onNavigation).toHaveBeenCalledWith({ kind: "navigate", step: 0 });
  });
});
