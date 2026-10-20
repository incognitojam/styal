import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ADD_PROVIDER_WIZARD_STEPS } from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";

function renderStepButtons(
  currentStep: number,
  instanceIdError: string | null,
  onNavigation: Parameters<typeof AddProviderInstanceWizardSteps>[0]["onNavigation"],
) {
  return render(
    <AddProviderInstanceWizardSteps
      currentStep={currentStep}
      summaries={["Codex", "Codex Workspace", null]}
      instanceIdError={instanceIdError}
      onNavigation={onNavigation}
    />,
  );
}

const stepButtons = (container: HTMLElement) => [...container.querySelectorAll("button")];

describe("AddProviderInstanceWizardSteps", () => {
  it("gates the actual Config header click through Identity validation", async () => {
    const onNavigation = vi.fn();
    await using screen = await renderStepButtons(0, "Instance ID is required.", onNavigation);
    const buttons = stepButtons(screen.container);

    expect(buttons).toHaveLength(ADD_PROVIDER_WIZARD_STEPS.length);
    await act(() => buttons[2]!.click());

    expect(onNavigation).toHaveBeenCalledOnce();
    expect(onNavigation).toHaveBeenCalledWith({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("marks the wizard step separately from the clicked button focus", async () => {
    await using screen = await renderStepButtons(1, "Instance ID is required.", vi.fn());
    const buttons = stepButtons(screen.container);

    expect(buttons[0]!.getAttribute("aria-current")).toBeNull();
    expect(buttons[1]!.getAttribute("aria-current")).toBe("step");
    expect(buttons[2]!.getAttribute("aria-current")).toBeNull();
  });

  it("preserves the actual backward header click", async () => {
    const onNavigation = vi.fn();
    await using screen = await renderStepButtons(2, "Instance ID is required.", onNavigation);
    const buttons = stepButtons(screen.container);

    await act(() => buttons[0]!.click());

    expect(onNavigation).toHaveBeenCalledWith({ kind: "navigate", step: 0 });
  });
});
